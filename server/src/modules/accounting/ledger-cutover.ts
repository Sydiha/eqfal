import { createHash } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { AccountingPeriodClosedError, lockAccountingRange } from '../monthly-close/accounting-period.guard';
import { lockVatPeriodScope } from '../vat/vat.router';
import { FiscalYearClosedError } from './fiscal-year-posting.guard';
import { JournalPostingConflictError, JournalPostingValidationError } from './journal-posting-errors';
import { postJournalInTransaction } from './journal-posting';
import { AUTHORITY_ERROR_CODES, AuthorityRange, LedgerSourceAuthorityError, LedgerSourceAuthorityNotFoundError } from './ledger-source-authority';

/**
 * C1B-3b: cut-over trial balance validation, preview and ATOMIC activation.
 * One transaction: lock -> validate -> create the cut-over journal (draft) -> post it while the range is still a draft -> draft -> active -> audit.
 * Any failure rolls back everything (no orphan journal, no half-active range). Database triggers (migration 086) re-enforce every invariant.
 * The balanced trial balance is NOT proof of correctness: warnings below are heuristics, and the accountant acknowledgements are recorded, not verified.
 */
export class CutoverValidationError extends LedgerSourceAuthorityError {
  constructor(code: string, public readonly detail?: unknown) { super(code); }
}

export type CutoverLine = { account_id: string; debit: string; credit: string };
export type CutoverInput = {
  lines: CutoverLine[];
  retained_earnings_account_id: string;
  tb_reference: string;
  tb_prepared_by: string;
  acknowledgements: { retained_earnings: true; current_year_pnl: true; cash_balances: true; account_level_limitations: true };
  idempotency_key?: string;
  /** Accounts that look like cash/bank but are classified non_cash, each individually confirmed by the accountant. Never changes a classification. */
  cash_non_cash_confirmed_account_ids: string[];
};
export type CutoverWarning = { code: string; detail?: unknown };
export type CutoverSummary = {
  line_count: number; total_debit: string; total_credit: string; cash_balance: string; profit_or_loss_to_date: string;
  retained_earnings_balance: string; warnings: CutoverWarning[];
};
export type CutoverResult = { valid: true; replayed: boolean; dry_run: boolean; range: AuthorityRange; journal_id: string | null; summary: CutoverSummary };
export type CutoverPreviewResult = { valid: boolean; blockers: Array<{ code: string; detail?: unknown }>; summary: CutoverSummary | null; range_id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY = /^\d{1,16}(\.\d{1,2})?$/;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_LINES = 2000;
const PNL = new Set(['revenue', 'cost_of_sales', 'operating_expense', 'finance_income', 'finance_expense', 'other_income', 'other_expense']);
const REQUIRED_ACKS = ['retained_earnings', 'current_year_pnl', 'cash_balances', 'account_level_limitations'] as const;

const cents = (value: string): bigint => { const [w, f = ''] = value.split('.'); return BigInt(w!) * 100n + BigInt((f + '00').slice(0, 2)); };
const money = (value: bigint): string => { const neg = value < 0n; const a = neg ? -value : value; return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };

/** Strict request-body parser: unknown keys, malformed amounts or missing acknowledgements -> null (400). */
export function parseCutoverInput(body: unknown, requireKey: boolean): CutoverInput | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const x = body as Record<string, unknown>;
  const allowed = ['lines', 'retained_earnings_account_id', 'tb_reference', 'tb_prepared_by', 'acknowledgements', 'idempotency_key', 'cash_non_cash_confirmed_account_ids', 'confirm'];
  if (Object.keys(x).some((k) => !allowed.includes(k))) return null;
  if (!Array.isArray(x['lines']) || x['lines'].length === 0 || x['lines'].length > MAX_LINES) return null;
  const lines: CutoverLine[] = [];
  for (const raw of x['lines'] as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const l = raw as Record<string, unknown>;
    if (Object.keys(l).some((k) => !['account_id', 'debit', 'credit'].includes(k))) return null;
    const debit = l['debit'] ?? '0', credit = l['credit'] ?? '0';
    if (typeof l['account_id'] !== 'string' || !UUID.test(l['account_id']) || typeof debit !== 'string' || typeof credit !== 'string' || !MONEY.test(debit) || !MONEY.test(credit)) return null;
    lines.push({ account_id: l['account_id'].toLowerCase(), debit, credit });
  }
  const text = (v: unknown) => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 200 ? v.trim() : null);
  const re = x['retained_earnings_account_id'];
  const ref = text(x['tb_reference']), by = text(x['tb_prepared_by']);
  const ack = x['acknowledgements'];
  if (typeof re !== 'string' || !UUID.test(re) || !ref || !by) return null;
  if (typeof ack !== 'object' || ack === null || Array.isArray(ack)) return null;
  const a = ack as Record<string, unknown>;
  if (Object.keys(a).some((k) => !(REQUIRED_ACKS as readonly string[]).includes(k)) || REQUIRED_ACKS.some((k) => a[k] !== true)) return null;
  const rawConfirmed = x['cash_non_cash_confirmed_account_ids'] ?? [];
  if (!Array.isArray(rawConfirmed) || rawConfirmed.length > MAX_LINES || rawConfirmed.some((id) => typeof id !== 'string' || !UUID.test(id))) return null;
  const confirmed = [...new Set((rawConfirmed as string[]).map((id) => id.toLowerCase()))].sort();
  const key = x['idempotency_key'];
  if (key !== undefined && (typeof key !== 'string' || !KEY.test(key))) return null;
  if (requireKey && key === undefined) return null;
  return {
    lines, retained_earnings_account_id: re.toLowerCase(), tb_reference: ref, tb_prepared_by: by,
    acknowledgements: { retained_earnings: true, current_year_pnl: true, cash_balances: true, account_level_limitations: true },
    cash_non_cash_confirmed_account_ids: confirmed,
    ...(key === undefined ? {} : { idempotency_key: key as string }),
  };
}

function payloadHash(input: CutoverInput): string {
  const lines = [...input.lines].map((l) => ({ a: l.account_id, d: money(cents(l.debit)), c: money(cents(l.credit)) })).sort((p, q) => p.a.localeCompare(q.a));
  return createHash('sha256').update(JSON.stringify({ lines, re: input.retained_earnings_account_id, ref: input.tb_reference, by: input.tb_prepared_by, ack: input.acknowledgements, cash: [...input.cash_non_cash_confirmed_account_ids].sort() })).digest('hex');
}

const CASH_NAME = /(bank|cash|petty|safe|treasury|صندوق|نقد|بنك|مصرف|خزينة|خزنة)/i;

type AccountRow = { id: string; code: string; name: string; name_ar: string | null; name_en: string | null; is_active: boolean; account_type: string; statement_category: string; cash_role: string; cash_flow_category: string };

/** Pure input checks + heuristic warnings (read-only). Throws CutoverValidationError with a stable code for every blocker. */
async function validateInput(client: PoolClient, companyId: string, input: CutoverInput): Promise<{ summary: CutoverSummary; net: Map<string, bigint> }> {
  const net = new Map<string, bigint>();
  for (const l of input.lines) {
    const d = cents(l.debit), c = cents(l.credit);
    if (net.has(l.account_id) || (d > 0n) === (c > 0n)) throw new CutoverValidationError('CUTOVER_LINES_INVALID', { account_id: l.account_id });
    net.set(l.account_id, d - c);
  }
  if (net.size < 2) throw new CutoverValidationError('CUTOVER_LINES_INVALID');
  const ids = [...new Set([...net.keys(), input.retained_earnings_account_id])];
  const accounts = new Map((await client.query<AccountRow>(
    'SELECT id,code,name,name_ar,name_en,is_active,account_type,statement_category,cash_role,cash_flow_category FROM accounts WHERE company_id=$1 AND id=ANY($2::uuid[])', [companyId, ids],
  )).rows.map((a) => [a.id, a]));
  for (const id of ids) if (!accounts.has(id)) throw new CutoverValidationError('CUTOVER_ACCOUNT_NOT_FOUND', { account_id: id });
  const re = accounts.get(input.retained_earnings_account_id)!;
  if (re.account_type !== 'equity' || re.statement_category !== 'equity') throw new CutoverValidationError('CUTOVER_RETAINED_ACCOUNT_INVALID', { account_id: re.id });
  const inactive = [...net.keys()].filter((id) => !accounts.get(id)!.is_active);
  if (inactive.length) throw new CutoverValidationError('CUTOVER_ACCOUNT_INACTIVE', { account_ids: inactive });
  const unmapped = [...net.keys()].filter((id) => accounts.get(id)!.statement_category === 'unmapped');
  if (unmapped.length) throw new CutoverValidationError('CUTOVER_ACCOUNT_UNMAPPED', { account_ids: unmapped });
  // Cash safeguard: a balance-sheet asset that reads like cash/bank but is classified non_cash would silently drop out of the cash-flow
  // statement. Each such account needs the accountant's individual confirmation; classifications are never changed here.
  const suspect = [...net].filter(([id, v]) => {
    const a = accounts.get(id)!;
    return v !== 0n && a.account_type === 'asset' && a.cash_role === 'non_cash' && CASH_NAME.test(`${a.name} ${a.name_ar ?? ''} ${a.name_en ?? ''}`);
  }).map(([id]) => id);
  const confirmedIds = input.cash_non_cash_confirmed_account_ids;
  const stray = confirmedIds.filter((id) => !suspect.includes(id));
  if (stray.length) throw new CutoverValidationError('CUTOVER_CASH_CONFIRMATION_INVALID', { account_ids: stray });
  const unconfirmed = suspect.filter((id) => !confirmedIds.includes(id));
  if (unconfirmed.length) throw new CutoverValidationError('CUTOVER_CASH_CLASSIFICATION_UNCONFIRMED', { accounts: unconfirmed.map((id) => ({ id, code: accounts.get(id)!.code, name: accounts.get(id)!.name })) });
  let debit = 0n, credit = 0n;
  for (const v of net.values()) if (v > 0n) debit += v; else credit -= v;
  if (debit !== credit || debit === 0n) throw new CutoverValidationError('CUTOVER_JOURNAL_UNBALANCED', { total_debit: money(debit), total_credit: money(credit) });

  let pnl = 0n, cash = 0n;
  for (const [id, v] of net) {
    const a = accounts.get(id)!;
    if (PNL.has(a.statement_category)) pnl -= v; // profit positive
    if (a.cash_role !== 'non_cash') cash += v;
  }
  const reNet = -(net.get(re.id) ?? 0n); // credit-positive
  const warnings: CutoverWarning[] = [{ code: 'CUTOVER_ACCOUNT_LEVEL_ONLY' }];
  if (reNet === 0n) warnings.push({ code: 'CUTOVER_RETAINED_EARNINGS_ZERO' });
  const abs = (v: bigint) => (v < 0n ? -v : v);
  if (pnl !== 0n) {
    const lookalike = [...net].filter(([id, v]) => id !== re.id && accounts.get(id)!.statement_category === 'equity' && abs(v) === abs(pnl)).map(([id]) => accounts.get(id)!.code);
    if (lookalike.length) warnings.push({ code: 'CUTOVER_EQUITY_MATCHES_PNL', detail: { account_codes: lookalike } });
  } else if (reNet !== 0n) warnings.push({ code: 'CUTOVER_PNL_EMPTY_WITH_RETAINED_EARNINGS' });
  if (cash === 0n) warnings.push({ code: 'CUTOVER_NO_CASH_BALANCE' });
  const cfUnmapped = [...net.keys()].map((id) => accounts.get(id)!).filter((a) => a.cash_role === 'non_cash' && a.cash_flow_category === 'unmapped' && !PNL.has(a.statement_category) && a.statement_category !== 'equity').map((a) => a.code);
  if (cfUnmapped.length) warnings.push({ code: 'CUTOVER_CASH_FLOW_UNMAPPED', detail: { account_codes: cfUnmapped.slice(0, 50), count: cfUnmapped.length } });
  return {
    net,
    summary: { line_count: net.size, total_debit: money(debit), total_credit: money(credit), cash_balance: money(cash), profit_or_loss_to_date: money(pnl), retained_earnings_balance: money(reNet), warnings },
  };
}

const RANGE_COLUMNS = `id,company_id,from_date::text,to_date::text,authority,status,reason,created_by,created_at,voided_by,voided_at,void_reason`;

export class LedgerCutoverService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  /** Read-only: runs the whole activation inside a transaction that is ALWAYS rolled back, so the verdict is the real one. */
  async preview(companyId: string, actor: string, rangeId: string, input: CutoverInput): Promise<CutoverPreviewResult> {
    try {
      const result = await this.run(companyId, actor, rangeId, input, true);
      return { valid: true, blockers: [], summary: result.summary, range_id: rangeId };
    } catch (error) {
      if (error instanceof LedgerSourceAuthorityNotFoundError) throw error;
      if (error instanceof LedgerSourceAuthorityError) {
        return { valid: false, blockers: [{ code: error.code, ...(error instanceof CutoverValidationError && error.detail !== undefined ? { detail: error.detail } : {}) }], summary: null, range_id: rangeId };
      }
      throw error;
    }
  }

  async activate(companyId: string, actor: string, rangeId: string, input: CutoverInput): Promise<CutoverResult> {
    return this.run(companyId, actor, rangeId, input, false);
  }

  private async run(companyId: string, actor: string, rangeId: string, input: CutoverInput, dryRun: boolean): Promise<CutoverResult> {
    const hash = payloadHash(input);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`source-authority:${companyId}`]);
      const range = (await client.query<AuthorityRange & { cutover_journal_id: string | null; activation_idempotency_key: string | null; activation_payload_hash: string | null; activation_snapshot: { summary?: CutoverSummary } | null }>(
        `SELECT ${RANGE_COLUMNS},cutover_journal_id,activation_idempotency_key,activation_payload_hash,activation_snapshot FROM ledger_source_authority WHERE id=$1 AND company_id=$2 FOR UPDATE`, [rangeId, companyId],
      )).rows[0];
      if (!range) throw new LedgerSourceAuthorityNotFoundError();
      if (range.status === 'active') {
        // Idempotent replay: same key AND same payload returns the stored outcome; anything else is a conflict.
        if (!dryRun && input.idempotency_key && range.activation_idempotency_key === input.idempotency_key && range.activation_payload_hash === hash) {
          await client.query('ROLLBACK');
          return { valid: true, replayed: true, dry_run: false, range: this.publicRange(range), journal_id: range.cutover_journal_id, summary: range.activation_snapshot!.summary! };
        }
        throw new CutoverValidationError('AUTHORITY_ALREADY_ACTIVE');
      }
      if (range.status !== 'draft') throw new CutoverValidationError('AUTHORITY_NOT_DRAFT');
      const when = (await client.query<{ today: string; month_end: boolean }>(
        `SELECT CURRENT_DATE::text today, ($1::date + 1) = date_trunc('month', $1::date + 1)::date AS month_end`, [range.to_date])).rows[0]!;
      if (!when.month_end) throw new CutoverValidationError('CUTOVER_DATE_NOT_MONTH_END');
      if (range.to_date > when.today) throw new CutoverValidationError('CUTOVER_DATE_IN_FUTURE');

      // Lock order (same as fiscal-year close): VAT keys, then accounting month keys ascending.
      await lockVatPeriodScope(companyId, range.from_date, range.to_date, client);
      await lockAccountingRange(companyId, range.from_date, range.to_date, client);

      const year = (await client.query<{ id: string }>('SELECT id FROM fiscal_years WHERE company_id=$1 AND start_date=$2::date', [companyId, range.from_date])).rows[0];
      if (!year) throw new CutoverValidationError('AUTHORITY_DRAFT_FISCAL_YEAR_INVALID');

      const { summary, net } = await validateInput(client, companyId, input);
      const profile = (await client.query<{ id: string; version_no: number; vat_status: string; vat_filing_frequency: string | null }>(
        `SELECT id,version_no,vat_status,vat_filing_frequency FROM company_accounting_profiles
         WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=($2::date+1) AND (effective_to IS NULL OR effective_to>=($2::date+1))`, [companyId, range.to_date],
      )).rows;
      const issue = (await client.query<{ issue: string | null }>('SELECT ledger_cutover_vat_issue($1,$2::date) issue', [companyId, range.to_date])).rows[0]!.issue;
      if (issue) throw new CutoverValidationError(issue);

      const journal = (await client.query<{ id: string }>(
        `INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,reference,entry_type,created_by)
         VALUES($1,$2,$3,$4,$5,'cutover_balance',$6) RETURNING id`,
        [companyId, year.id, range.to_date, `Cut-over balances as at ${range.to_date}`, input.tb_reference, actor],
      )).rows[0]!;
      const codes = new Map((await client.query<{ id: string; code: string }>('SELECT id,code FROM accounts WHERE company_id=$1 AND id=ANY($2::uuid[])', [companyId, [...net.keys()]])).rows.map((a) => [a.id, a.code]));
      let sequence = 1;
      for (const id of [...net.keys()].sort((a, b) => (codes.get(a)! < codes.get(b)! ? -1 : codes.get(a)! > codes.get(b)! ? 1 : a < b ? -1 : 1))) {
        const v = net.get(id)!;
        await client.query('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,$4,$5,$6)',
          [companyId, journal.id, id, v > 0n ? money(v) : '0.00', v < 0n ? money(-v) : '0.00', sequence++]);
      }
      await postJournalInTransaction(client, companyId, actor, journal.id, { cutoverAuthorityId: range.id });

      const snapshot = { summary, vat_profile: profile[0] ? { id: profile[0].id, version_no: profile[0].version_no, vat_status: profile[0].vat_status, vat_filing_frequency: profile[0].vat_filing_frequency } : null, retained_earnings_account_id: input.retained_earnings_account_id, cash_non_cash_confirmed_account_ids: input.cash_non_cash_confirmed_account_ids };
      const key = input.idempotency_key ?? `preview-${range.id}`;
      const active = (await client.query<AuthorityRange>(
        `UPDATE ledger_source_authority SET status='active',cutover_journal_id=$3,activated_by=$4,activated_at=NOW(),tb_reference=$5,tb_prepared_by=$6,
           acknowledgements=$7::jsonb,activation_snapshot=$8::jsonb,activation_idempotency_key=$9,activation_payload_hash=$10
         WHERE id=$1 AND company_id=$2 AND status='draft' RETURNING ${RANGE_COLUMNS}`,
        [range.id, companyId, journal.id, actor, input.tb_reference, input.tb_prepared_by, JSON.stringify(input.acknowledgements), JSON.stringify(snapshot), key, hash],
      )).rows[0];
      if (!active) throw new CutoverValidationError('AUTHORITY_NOT_DRAFT');
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'ledger_source_authority.activate', entity_type: 'ledger_source_authority', entity_id: range.id,
        before_data: { status: 'draft' },
        after_data: { status: 'active', from_date: range.from_date, to_date: range.to_date, cutover_journal_id: journal.id, tb_reference: input.tb_reference, tb_prepared_by: input.tb_prepared_by, acknowledgements: input.acknowledgements, totals: { total_debit: summary.total_debit, total_credit: summary.total_credit, line_count: summary.line_count }, warnings: summary.warnings.map((w) => w.code), vat_profile: snapshot.vat_profile, cash_non_cash_confirmed_account_ids: input.cash_non_cash_confirmed_account_ids },
        reason: range.reason,
      }, client);
      if (dryRun) await client.query('ROLLBACK'); else await client.query('COMMIT');
      return { valid: true, replayed: false, dry_run: dryRun, range: this.publicRange(active), journal_id: dryRun ? null : journal.id, summary };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return this.translate(error);
    } finally {
      client.release();
    }
  }

  private publicRange(range: AuthorityRange): AuthorityRange {
    return { id: range.id, company_id: range.company_id, from_date: range.from_date, to_date: range.to_date, authority: range.authority, status: range.status, reason: range.reason, created_by: range.created_by, created_at: range.created_at, voided_by: range.voided_by, voided_at: range.voided_at, void_reason: range.void_reason };
  }

  private translate(error: unknown): never {
    if (error instanceof LedgerSourceAuthorityError || error instanceof LedgerSourceAuthorityNotFoundError) throw error;
    if (error instanceof AccountingPeriodClosedError || error instanceof FiscalYearClosedError) throw new CutoverValidationError('AUTHORITY_RANGE_CLOSED_PERIOD');
    if (error instanceof JournalPostingValidationError) throw new CutoverValidationError('CUTOVER_JOURNAL_INVALID', error.message);
    if (error instanceof JournalPostingConflictError && 'code' in error && typeof (error as { code: unknown }).code === 'string') throw new CutoverValidationError((error as { code: string }).code);
    const e = error as { message?: string; code?: string; constraint?: string };
    if (e.message && (AUTHORITY_ERROR_CODES as readonly string[]).includes(e.message)) throw new CutoverValidationError(e.message);
    if (e.code === '23505' && e.constraint === 'ledger_source_authority_idem_uidx') throw new CutoverValidationError('AUTHORITY_IDEMPOTENCY_KEY_REUSED');
    if (e.code === '23505' && e.constraint === 'journal_entries_one_cutover_uidx') throw new CutoverValidationError('CUTOVER_JOURNAL_EXISTS');
    throw error;
  }
}
