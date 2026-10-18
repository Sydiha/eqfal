import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';

/**
 * T2 / G3: the single statement-balance reconciliation calculation. Monthly close, fiscal-year close and the bank page all call
 * `evaluateCompanyBankReconciliation`; nothing else computes a bank-versus-ledger difference.
 *
 *   adjusted bank balance = confirmed statement closing balance + net of EVIDENCED outstanding items
 *   adjusted GL balance   = every posted journal line (debit - credit) on the linked ledger account up to the period end
 *   difference            = adjusted bank balance - adjusted GL balance; the tolerance is exactly zero
 *
 * An outstanding item is a posted GL entry on the linked account that (a) is dated on or before the period end and (b) is tied by its
 * source record (settlement, custody funding/return, posted partner transaction) to an imported bank transaction of the SAME bank account
 * dated AFTER the period end, with identical amount and direction. An unmatched journal line is never assumed outstanding, and a bank-only
 * transaction is never treated as resolved: both stay inside the unexplained difference until an accounting entry exists.
 */
export type Queryable = Pool | PoolClient;
export type ReconciliationMode = 'off' | 'warn' | 'enforce';
export type AccountProblem = 'unmapped' | 'currency_unverified' | 'currency_mismatch' | 'statement_missing' | 'difference_unexplained';
export type AccountWarning = 'outstanding_aged' | 'bank_only_items';

export const AGED_OUTSTANDING_DAYS = 10;

/**
 * One definition of an unresolved bank transaction, shared by the monthly and annual closing counts (alias `t` = bank_transactions).
 * Resolved only by a ledger-bearing relationship (settlement, custody movement, posted partner transaction). A bare `reconciliation_status`
 * never counts as accounting completion (sales-purchases-ledger-coverage contract).
 */
export const UNRESOLVED_BANK_TRANSACTION_SQL = `NOT (
        EXISTS(SELECT 1 FROM obligation_settlements s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
        OR EXISTS(SELECT 1 FROM bank_transaction_matches m WHERE m.company_id=t.company_id AND m.bank_transaction_id=t.id AND m.match_type IN ('custody_funding','custody_return'))
        OR EXISTS(SELECT 1 FROM partner_transactions pt WHERE pt.company_id=t.company_id AND pt.bank_transaction_id=t.id AND pt.status='posted')
        OR EXISTS(SELECT 1 FROM personal_payment_reimbursements pr WHERE pr.company_id=t.company_id AND pr.bank_transaction_id=t.id AND pr.journal_entry_id IS NOT NULL)
        OR EXISTS(SELECT 1 FROM bank_transaction_matches m JOIN document_settlements s ON s.company_id=m.company_id AND s.bank_transaction_id=m.bank_transaction_id AND s.document_id=m.document_id WHERE m.company_id=t.company_id AND m.bank_transaction_id=t.id AND m.match_type='document')
      )`;

export type OutstandingItem = {
  journal_entry_id: string; accounting_date: string; description: string; bank_transaction_id: string; bank_transaction_date: string;
  kind: 'deposit_in_transit' | 'outstanding_payment'; amount: string; days_after_period_end: number; aged: boolean;
};
export type RejectedEvidence = { journal_entry_id: string; bank_transaction_id: string; reason: 'amount_or_direction_mismatch' | 'duplicate_evidence'; journal_net: string; bank_amount: string };
export type AccountReconciliation = {
  bank_account_id: string; display_name: string; currency_code: string; period_end: string;
  ledger_account_id: string | null; functional_currency: string | null;
  statement_id: string | null; statement_ref: string | null; statement_closing_balance: string | null;
  gl_balance: string | null; deposits_in_transit: string; outstanding_payments: string;
  adjusted_bank_balance: string | null; adjusted_gl_balance: string | null; difference: string | null;
  outstanding_items: OutstandingItem[]; rejected_evidence: RejectedEvidence[];
  bank_only_count: number; problems: AccountProblem[]; warnings: AccountWarning[]; reconciled: boolean;
};
export type CompanyReconciliation = {
  mode: ReconciliationMode; effective_mode: ReconciliationMode; enforce_from: string | null; period_start: string; period_end: string;
  accounts: AccountReconciliation[]; blockers: number; warnings: number;
};
export type ReconciliationSettings = { company_id: string; mode: ReconciliationMode; enforce_from: string | null; version: number; updated_at: string | null };

/* ---- exact money arithmetic (integer cents; no floating point) ---- */
export function toCents(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid money value: ${value}`);
  const cents = BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0') || '0');
  return match[1] ? -cents : cents;
}
export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export async function loadReconciliationSettings(db: Queryable, companyId: string): Promise<ReconciliationSettings> {
  const row = (await db.query<{ mode: ReconciliationMode; enforce_from: string | null; version: number; updated_at: string }>(
    'SELECT mode,enforce_from::text,version,updated_at::text FROM company_bank_reconciliation_settings WHERE company_id=$1', [companyId],
  )).rows[0];
  // A missing row (every company before activation) is 'off'; an unrecognised value fails closed to 'off' rather than silently enforcing.
  if (!row || (row.mode !== 'warn' && row.mode !== 'enforce')) return { company_id: companyId, mode: 'off', enforce_from: null, version: row?.mode === 'off' ? Number(row.version) : 0, updated_at: row?.mode === 'off' ? row.updated_at : null };
  return { company_id: companyId, ...row };
}

export function effectiveMode(settings: Pick<ReconciliationSettings, 'mode' | 'enforce_from'>, periodEnd: string): ReconciliationMode {
  if (settings.mode === 'enforce') return settings.enforce_from !== null && periodEnd >= settings.enforce_from ? 'enforce' : 'warn';
  return settings.mode;
}

/** Same key the statement workflows take, so a close and a statement change on one bank account cannot interleave. */
export async function lockBankAccountReconciliation(client: PoolClient, companyId: string, bankAccountId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bank-statement:${companyId}:${bankAccountId}`]);
}

type CandidateRow = { id: string; display_name: string; currency_code: string };
type EvidenceRow = { journal_id: string; accounting_date: string; description: string; bank_transaction_id: string; bank_transaction_date: string; bank_amount: string; net: string };

const EVIDENCE_SQL = `WITH src AS (
  SELECT j.id journal_id, s.bank_transaction_id
    FROM journal_entries j JOIN document_settlements s ON s.id=j.source_id AND s.company_id=j.company_id
   WHERE j.company_id=$1 AND j.source_type='document_settlement'
  UNION ALL
  SELECT j.id, s.bank_transaction_id
    FROM journal_entries j JOIN obligation_settlements s ON s.id=j.source_id AND s.company_id=j.company_id
   WHERE j.company_id=$1 AND j.source_type='obligation_settlement'
  UNION ALL
  SELECT j.id, m.bank_transaction_id
    FROM journal_entries j JOIN bank_transaction_matches m ON m.id=j.source_id AND m.company_id=j.company_id AND m.match_type=j.source_type
   WHERE j.company_id=$1 AND j.source_type IN ('custody_funding','custody_return')
  UNION ALL
  SELECT j.id, p.bank_transaction_id
    FROM journal_entries j JOIN partner_transactions p ON p.id=j.source_id AND p.company_id=j.company_id
   WHERE j.company_id=$1 AND j.source_type='partner_transaction' AND p.status='posted' AND p.bank_transaction_id IS NOT NULL
  UNION ALL
  SELECT j.id, r.bank_transaction_id
    FROM journal_entries j JOIN personal_payment_reimbursements r ON r.id=j.source_id AND r.company_id=j.company_id
   WHERE j.company_id=$1 AND j.source_type='personal_payment_reimbursement'
)
SELECT j.id journal_id, j.accounting_date::text, j.description, bt.id bank_transaction_id, bt.transaction_date::text bank_transaction_date,
       bt.amount::text bank_amount,
       (SELECT COALESCE(SUM(l.debit-l.credit),0) FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.company_id=j.company_id AND l.account_id=$3)::text net
  FROM src
  JOIN journal_entries j ON j.id=src.journal_id AND j.company_id=$1
  JOIN bank_transactions bt ON bt.id=src.bank_transaction_id AND bt.company_id=$1
 WHERE j.status='posted' AND j.accounting_date<=$4::date AND bt.bank_account_id=$2 AND bt.transaction_date>$4::date
   AND EXISTS(SELECT 1 FROM journal_lines l WHERE l.journal_entry_id=j.id AND l.company_id=j.company_id AND l.account_id=$3)
 ORDER BY j.accounting_date, j.id`;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

async function evaluateAccount(db: Queryable, companyId: string, bank: CandidateRow, periodEnd: string, functionalCurrency: string | null): Promise<AccountReconciliation> {
  const link = (await db.query<{ account_id: string }>(
    `SELECT account_id FROM bank_account_ledger_links WHERE company_id=$1 AND bank_account_id=$2 AND valid_from<=$3::date AND (valid_to IS NULL OR valid_to>=$3::date)`,
    [companyId, bank.id, periodEnd],
  )).rows[0];
  const statement = (await db.query<{ id: string; statement_ref: string; closing_balance: string }>(
    `SELECT id,statement_ref,closing_balance::text FROM bank_statement_balances WHERE company_id=$1 AND bank_account_id=$2 AND period_end=$3::date AND status='confirmed'`,
    [companyId, bank.id, periodEnd],
  )).rows[0];
  const bankOnly = Number((await db.query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM bank_transactions t WHERE t.company_id=$1 AND t.bank_account_id=$2 AND t.transaction_date<=$3::date AND ${UNRESOLVED_BANK_TRANSACTION_SQL}`,
    [companyId, bank.id, periodEnd],
  )).rows[0]!.n);

  const problems: AccountProblem[] = [];
  const warnings: AccountWarning[] = [];
  const base = {
    bank_account_id: bank.id, display_name: bank.display_name, currency_code: bank.currency_code, period_end: periodEnd,
    ledger_account_id: link?.account_id ?? null, functional_currency: functionalCurrency,
    statement_id: statement?.id ?? null, statement_ref: statement?.statement_ref ?? null, statement_closing_balance: statement?.closing_balance ?? null,
    bank_only_count: bankOnly,
  };
  if (bankOnly > 0) warnings.push('bank_only_items');
  if (!link) problems.push('unmapped');
  if (functionalCurrency === null) problems.push('currency_unverified');
  else if (bank.currency_code.trim() !== functionalCurrency) problems.push('currency_mismatch');
  if (!statement) problems.push('statement_missing');
  if (!link || problems.includes('currency_mismatch') || problems.includes('currency_unverified') || !statement) {
    return {
      ...base, gl_balance: null, deposits_in_transit: '0.00', outstanding_payments: '0.00', adjusted_bank_balance: null, adjusted_gl_balance: null, difference: null,
      outstanding_items: [], rejected_evidence: [], problems, warnings, reconciled: false,
    };
  }

  const glBalance = toCents((await db.query<{ bal: string }>(
    `SELECT COALESCE(SUM(l.debit-l.credit),0)::text bal FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
      WHERE l.company_id=$1 AND l.account_id=$2 AND j.status='posted' AND j.accounting_date<=$3::date`, [companyId, link.account_id, periodEnd],
  )).rows[0]!.bal);

  const items: OutstandingItem[] = [];
  const rejected: RejectedEvidence[] = [];
  let deposits = 0n;
  let payments = 0n;
  const evidenceRows = (await db.query<EvidenceRow>(EVIDENCE_SQL, [companyId, bank.id, link.account_id, periodEnd])).rows;
  // One imported bank row can offset only one GL entry. If several posted entries claim the same row (the schema should prevent it), none of them is trusted.
  const claims = new Map<string, number>();
  for (const row of evidenceRows) claims.set(row.bank_transaction_id, (claims.get(row.bank_transaction_id) ?? 0) + 1);
  for (const row of evidenceRows) {
    const net = toCents(row.net);
    const bankAmount = toCents(row.bank_amount);
    if ((claims.get(row.bank_transaction_id) ?? 0) > 1) {
      rejected.push({ journal_entry_id: row.journal_id, bank_transaction_id: row.bank_transaction_id, reason: 'duplicate_evidence', journal_net: fromCents(net), bank_amount: fromCents(bankAmount) });
      continue;
    }
    // Evidence must agree with the imported bank row in amount AND direction; anything else stays in the unexplained difference.
    if (net === 0n || net !== bankAmount) {
      rejected.push({ journal_entry_id: row.journal_id, bank_transaction_id: row.bank_transaction_id, reason: 'amount_or_direction_mismatch', journal_net: fromCents(net), bank_amount: fromCents(bankAmount) });
      continue;
    }
    const days = daysBetween(periodEnd, row.bank_transaction_date);
    const aged = days > AGED_OUTSTANDING_DAYS;
    if (aged && !warnings.includes('outstanding_aged')) warnings.push('outstanding_aged');
    if (net > 0n) deposits += net; else payments += -net;
    items.push({
      journal_entry_id: row.journal_id, accounting_date: row.accounting_date, description: row.description, bank_transaction_id: row.bank_transaction_id,
      bank_transaction_date: row.bank_transaction_date, kind: net > 0n ? 'deposit_in_transit' : 'outstanding_payment', amount: fromCents(net > 0n ? net : -net),
      days_after_period_end: days, aged,
    });
  }
  const adjustedBank = toCents(statement.closing_balance) + deposits - payments;
  const difference = adjustedBank - glBalance;
  if (difference !== 0n) problems.push('difference_unexplained');
  return {
    ...base, gl_balance: fromCents(glBalance), deposits_in_transit: fromCents(deposits), outstanding_payments: fromCents(payments),
    adjusted_bank_balance: fromCents(adjustedBank), adjusted_gl_balance: fromCents(glBalance), difference: fromCents(difference),
    outstanding_items: items, rejected_evidence: rejected, problems, warnings, reconciled: problems.length === 0,
  };
}

export type EvaluateOptions = {
  /** Closing transactions pass a PoolClient and set this: per-account statement locks are taken (sorted) before any statement is read. */
  lock?: boolean;
  /** Evaluate only these bank accounts (statement screens). */
  bankAccountId?: string;
};

export async function evaluateCompanyBankReconciliation(
  db: Queryable, companyId: string, periodStart: string, periodEnd: string, options: EvaluateOptions = {},
): Promise<CompanyReconciliation> {
  const settings = await loadReconciliationSettings(db, companyId);
  const mode = effectiveMode(settings, periodEnd);
  const empty: CompanyReconciliation = { mode: settings.mode, effective_mode: mode, enforce_from: settings.enforce_from, period_start: periodStart, period_end: periodEnd, accounts: [], blockers: 0, warnings: 0 };
  if (mode === 'off' && !options.bankAccountId) return empty;

  const candidates = (await db.query<CandidateRow>(
    `SELECT a.id,a.display_name,a.currency_code FROM bank_accounts a
      WHERE a.company_id=$1 AND ($4::uuid IS NULL OR a.id=$4::uuid)
        AND ($4::uuid IS NOT NULL OR (a.is_active AND (
              EXISTS(SELECT 1 FROM bank_account_ledger_links k WHERE k.company_id=a.company_id AND k.bank_account_id=a.id AND k.valid_from<=$3::date AND (k.valid_to IS NULL OR k.valid_to>=$3::date))
              OR EXISTS(SELECT 1 FROM bank_transactions t WHERE t.company_id=a.company_id AND t.bank_account_id=a.id AND t.transaction_date BETWEEN $2::date AND $3::date))))
      ORDER BY a.id`,
    [companyId, periodStart, periodEnd, options.bankAccountId ?? null],
  )).rows;
  if (options.lock) for (const bank of candidates) await lockBankAccountReconciliation(db as PoolClient, companyId, bank.id);

  const functional = (await db.query<{ functional_currency: string }>(
    `SELECT functional_currency FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$2::date AND (effective_to IS NULL OR effective_to>=$2::date)
      ORDER BY effective_from DESC, version_no DESC LIMIT 1`, [companyId, periodEnd],
  )).rows[0]?.functional_currency ?? null;

  const accounts: AccountReconciliation[] = [];
  for (const bank of candidates) accounts.push(await evaluateAccount(db, companyId, bank, periodEnd, functional));
  const withProblems = accounts.filter(a => a.problems.length > 0).length;
  const withWarnings = accounts.filter(a => a.warnings.length > 0).length;
  return {
    ...empty, accounts,
    blockers: mode === 'enforce' ? withProblems : 0,
    warnings: (mode === 'warn' ? withProblems : 0) + withWarnings,
  };
}

export function snapshotHash(account: AccountReconciliation): string {
  return createHash('sha256').update(JSON.stringify(account)).digest('hex');
}

/** Append-only evidence of what a close relied on. Only called inside the closing transaction, after the calculation passed. */
export async function recordReconciliationSnapshots(
  client: PoolClient, companyId: string, scope: 'monthly_close' | 'fiscal_year_close', scopeId: string, evaluation: CompanyReconciliation, actor: string,
): Promise<number> {
  if (evaluation.effective_mode === 'off') return 0;
  const mode = evaluation.effective_mode;
  for (const account of evaluation.accounts) {
    await client.query(
      `INSERT INTO bank_reconciliation_snapshots(company_id,bank_account_id,scope,scope_id,period_end,statement_id,mode,outcome,difference,result,result_sha256,recorded_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [companyId, account.bank_account_id, scope, scopeId, evaluation.period_end, account.statement_id, mode, account.reconciled ? 'reconciled' : 'attention',
        account.difference, JSON.stringify(account), snapshotHash(account), actor],
    );
  }
  return evaluation.accounts.length;
}
