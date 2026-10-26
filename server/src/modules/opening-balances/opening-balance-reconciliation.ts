import type { PoolClient } from 'pg';
import { fromCents, lockBankAccountReconciliation, toCents } from '../banking/bank-reconciliation-core';

// C4-P2a: read-only integrity and reconciliation gate for opening balance reviews. It never writes, never creates or changes a
// journal, an item, an obligation or a bank record. Money is compared as integer halalas, with no tolerance.
//
// Classification (worst wins): blocked > mismatch > incomplete_evidence > verified.
//   blocked             a reference is invalid, foreign, duplicated or contradicts the item or its GL account.
//   mismatch            two exact amounts that should agree do not (a confirmed accounting difference).
//   incomplete_evidence the evidence needed to verify is absent or not comparable (imported aggregate items, items with a missing
//                       reference, no confirmed statement, a different currency, an unmapped control account, a total that
//                       cannot be proven complete). Reported, never treated as a mismatch.
// Only `blocked` and `mismatch` stop submission and approval. A bank running balance is never evidence of the opening balance.
//
// Provenance: only rows written by the trial-balance import (see `provenance`) are genuine aggregates. An item entered or edited by
// hand without its reference is `OB_REFERENCE_MISSING`; when exactly one reference is implied (the counterparty's only unclaimed
// opening obligation, or the only bank account linked to the item's GL account) its amount is still compared 1:1, so removing a
// reference cannot hide a confirmed difference.
// Totals are never a confirmed mismatch: the schema cannot prove the opening obligation population complete.

export type ReconciliationStatus = 'verified' | 'incomplete_evidence' | 'mismatch' | 'blocked';
export type ReconciliationSection = 'bank' | 'receivable' | 'payable';

export const OB_RECONCILIATION_BLOCKED_CODE = 'OPENING_BALANCE_RECONCILIATION_BLOCKED';
export const OB_CODES = {
  referenceInvalid: 'OB_REFERENCE_INVALID',
  bankLedgerLinkMissing: 'OB_BANK_LEDGER_LINK_MISSING',
  bankGlMismatch: 'OB_BANK_ACCOUNT_GL_MISMATCH',
  bankDuplicate: 'OB_BANK_DUPLICATE',
  bankAggregateOnly: 'OB_BANK_AGGREGATE_ONLY',
  referenceMissing: 'OB_REFERENCE_MISSING',
  bankEvidenceMissing: 'OB_BANK_EVIDENCE_MISSING',
  bankAmountMismatch: 'OB_BANK_AMOUNT_MISMATCH',
  bankCurrencyNotComparable: 'OB_BANK_CURRENCY_NOT_COMPARABLE',
  functionalCurrencyUnknown: 'OB_FUNCTIONAL_CURRENCY_UNKNOWN',
  obligationInvalid: 'OB_OBLIGATION_INVALID',
  obligationNotOpening: 'OB_OBLIGATION_NOT_OPENING',
  obligationDirectionMismatch: 'OB_OBLIGATION_DIRECTION_MISMATCH',
  obligationDuplicate: 'OB_OBLIGATION_DUPLICATE',
  obligationAmountMismatch: 'OB_OBLIGATION_AMOUNT_MISMATCH',
  obligationSideMismatch: 'OB_OBLIGATION_SIDE_MISMATCH',
  counterpartyMismatch: 'OB_COUNTERPARTY_MISMATCH',
  controlAccountUnmapped: 'OB_CONTROL_ACCOUNT_UNMAPPED',
  controlAccountMismatch: 'OB_CONTROL_ACCOUNT_MISMATCH',
  subledgerAggregateOnly: 'OB_SUBLEDGER_AGGREGATE_ONLY',
  subledgerUnlinkedObligation: 'OB_SUBLEDGER_UNLINKED_OBLIGATION',
  subledgerTotalDifference: 'OB_SUBLEDGER_TOTAL_DIFFERENCE',
} as const;

export type ReconciliationIssue = {
  code: string;
  class: Exclude<ReconciliationStatus, 'verified'>;
  section: ReconciliationSection;
  item_id?: string;
  detail?: Record<string, string>;
};

export type ReconciliationItem = {
  id: string; category: string; account_id: string; amount: string; balance_side: 'debit' | 'credit';
  counterparty_id: string | null; bank_account_id: string | null; obligation_id: string | null;
  /** `import` only for an untouched row written by the trial-balance import; everything else is `manual`. */
  provenance: 'import' | 'manual';
};
export type ReconciliationObligation = {
  id: string; direction: 'receivable' | 'payable'; counterparty_id: string; original_amount: string;
  source_type: string; is_cancelled: boolean; recognized_on: string;
};
export type ReconciliationInput = {
  startDate: string;
  functionalCurrency: string | null;
  items: ReconciliationItem[];
  bankAccounts: Map<string, { currency_code: string }>;
  /** GL accounts linked to each bank account on the fiscal year start date. */
  bankLinks: Map<string, string[]>;
  /** Bank accounts linked to each GL account on the start date (used only to imply a missing bank reference). */
  bankLinksByAccount: Map<string, string[]>;
  /** Confirmed statement closing balance dated the day before the start date, per bank account. */
  statements: Map<string, { closing_balance: string; currency_code: string; id?: string }>;
  referencedObligations: Map<string, ReconciliationObligation>;
  /** Every live opening obligation recognised on the start date. */
  openingObligations: ReconciliationObligation[];
  /** Mapped control account plus its descendants, per direction. Absent key means no mapping. */
  controlAccounts: Map<'receivable' | 'payable', Set<string>>;
};
export type ReconciliationSectionReport = {
  status: ReconciliationStatus; item_count: number; gl_total: string; subledger_total: string | null;
};
export type ReconciliationReport = {
  status: ReconciliationStatus;
  blocking: boolean;
  as_of_date: string;
  sections: Record<ReconciliationSection, ReconciliationSectionReport>;
  issues: ReconciliationIssue[];
};

const RANK: Record<ReconciliationStatus, number> = { verified: 0, incomplete_evidence: 1, mismatch: 2, blocked: 3 };
const worst = (a: ReconciliationStatus, b: ReconciliationStatus): ReconciliationStatus => (RANK[a] >= RANK[b] ? a : b);
const signed = (i: { amount: string; balance_side: string }) => (i.balance_side === 'debit' ? toCents(i.amount) : -toCents(i.amount));

export function evaluateOpeningReconciliation(input: ReconciliationInput): ReconciliationReport {
  const issues: ReconciliationIssue[] = [];
  const add = (section: ReconciliationSection, klass: ReconciliationIssue['class'], code: string, item?: ReconciliationItem, detail?: Record<string, string>) =>
    issues.push({ code, class: klass, section, ...(item ? { item_id: item.id } : {}), ...(detail ? { detail } : {}) });

  // ---- bank ----
  const bankItems = input.items.filter((i) => i.category === 'bank');
  const seenBank = new Map<string, number>();
  for (const i of bankItems) if (i.bank_account_id) seenBank.set(i.bank_account_id, (seenBank.get(i.bank_account_id) ?? 0) + 1);
  /** Currency and confirmed-statement comparison for one item and the bank account it refers to (stated or implied). */
  const compareBank = (i: ReconciliationItem, bankId: string, inferred: boolean) => {
    const bank = input.bankAccounts.get(bankId)!;
    const mark: Record<string, string> = inferred ? { inferred: 'true' } : {};
    if (!input.functionalCurrency) { add('bank', 'incomplete_evidence', OB_CODES.functionalCurrencyUnknown, i); return; }
    if (bank.currency_code !== input.functionalCurrency) {
      add('bank', 'incomplete_evidence', OB_CODES.bankCurrencyNotComparable, i, { bank_currency: bank.currency_code, functional_currency: input.functionalCurrency });
      return;
    }
    const stmt = input.statements.get(bankId);
    if (!stmt) { add('bank', 'incomplete_evidence', OB_CODES.bankEvidenceMissing, i); return; }
    if (stmt.currency_code !== bank.currency_code) {
      add('bank', 'incomplete_evidence', OB_CODES.bankCurrencyNotComparable, i, { bank_currency: bank.currency_code, statement_currency: stmt.currency_code });
      return;
    }
    const expected = toCents(stmt.closing_balance), actual = signed(i);
    if (expected !== actual) {
      add('bank', 'mismatch', OB_CODES.bankAmountMismatch, i, { expected: fromCents(expected), actual: fromCents(actual), difference: fromCents(actual - expected), ...mark });
    }
  };
  for (const i of bankItems) {
    if (!i.bank_account_id) {
      if (i.provenance === 'import') { add('bank', 'incomplete_evidence', OB_CODES.bankAggregateOnly, i); continue; }
      const implied = [...new Set(input.bankLinksByAccount.get(i.account_id) ?? [])].filter((b) => input.bankAccounts.has(b));
      add('bank', 'incomplete_evidence', OB_CODES.referenceMissing, i, { reference: 'bank_account_id', ...(implied.length === 1 ? { implied_bank_account_id: implied[0]! } : {}) });
      if (implied.length === 1) compareBank(i, implied[0]!, true);
      continue;
    }
    if (!input.bankAccounts.has(i.bank_account_id)) { add('bank', 'blocked', OB_CODES.referenceInvalid, i, { reference: 'bank_account_id' }); continue; }
    if (seenBank.get(i.bank_account_id)! > 1) add('bank', 'blocked', OB_CODES.bankDuplicate, i, { bank_account_id: i.bank_account_id });
    const links = input.bankLinks.get(i.bank_account_id) ?? [];
    if (!links.length) add('bank', 'blocked', OB_CODES.bankLedgerLinkMissing, i, { as_of_date: input.startDate });
    else if (!links.includes(i.account_id)) add('bank', 'blocked', OB_CODES.bankGlMismatch, i, { account_id: i.account_id, linked_account_ids: links.join(',') });
    compareBank(i, i.bank_account_id, false);
  }

  // ---- receivable / payable ----
  const obligationUse = new Map<string, number>();
  for (const i of input.items) if ((i.category === 'receivable' || i.category === 'payable') && i.obligation_id) obligationUse.set(i.obligation_id, (obligationUse.get(i.obligation_id) ?? 0) + 1);
  const subledgerTotals: Record<'receivable' | 'payable', bigint> = { receivable: 0n, payable: 0n };
  for (const o of input.openingObligations) subledgerTotals[o.direction] += toCents(o.original_amount);
  const glTotals: Record<'receivable' | 'payable', bigint> = { receivable: 0n, payable: 0n };

  for (const section of ['receivable', 'payable'] as const) {
    const naturalSide = section === 'receivable' ? 'debit' : 'credit';
    for (const i of input.items.filter((x) => x.category === section)) {
      glTotals[section] += i.balance_side === naturalSide ? toCents(i.amount) : -toCents(i.amount);
      if (!i.obligation_id) {
        if (i.provenance === 'import') { add(section, 'incomplete_evidence', OB_CODES.subledgerAggregateOnly, i); continue; }
        // Entered or edited by hand without its obligation: never a legitimate aggregate. If the counterparty has exactly one
        // opening obligation that no stated reference claims, it is the implied one and the amount is still compared 1:1.
        const candidates = i.counterparty_id
          ? input.openingObligations.filter((o) => o.direction === section && o.counterparty_id === i.counterparty_id && !obligationUse.has(o.id))
          : [];
        const sameCounterparty = input.items.filter((x) => x.category === section && !x.obligation_id && x.counterparty_id === i.counterparty_id).length;
        const implied = candidates.length === 1 && sameCounterparty === 1 ? candidates[0]! : null;
        add(section, 'incomplete_evidence', OB_CODES.referenceMissing, i, { reference: 'obligation_id', ...(implied ? { implied_obligation_id: implied.id } : {}) });
        if (implied) {
          const naturalSide = section === 'receivable' ? 'debit' : 'credit';
          if (i.balance_side !== naturalSide) add(section, 'mismatch', OB_CODES.obligationSideMismatch, i, { expected_side: naturalSide, actual_side: i.balance_side, inferred: 'true' });
          const expected = toCents(implied.original_amount), actual = toCents(i.amount);
          if (expected !== actual) add(section, 'mismatch', OB_CODES.obligationAmountMismatch, i, { expected: fromCents(expected), actual: fromCents(actual), difference: fromCents(actual - expected), inferred: 'true' });
        }
        continue;
      }
      const o = input.referencedObligations.get(i.obligation_id);
      if (!o || o.is_cancelled) { add(section, 'blocked', OB_CODES.obligationInvalid, i, { obligation_id: i.obligation_id, reason: o ? 'cancelled' : 'not_found' }); continue; }
      if (o.source_type !== 'opening_balance' || o.recognized_on !== input.startDate) {
        add(section, 'blocked', OB_CODES.obligationNotOpening, i, { obligation_id: o.id, source_type: o.source_type, recognized_on: o.recognized_on });
        continue;
      }
      if (obligationUse.get(o.id)! > 1) add(section, 'blocked', OB_CODES.obligationDuplicate, i, { obligation_id: o.id });
      if (o.direction !== section) add(section, 'blocked', OB_CODES.obligationDirectionMismatch, i, { obligation_direction: o.direction, category: section });
      if (i.counterparty_id && i.counterparty_id !== o.counterparty_id) add(section, 'blocked', OB_CODES.counterpartyMismatch, i, { item_counterparty_id: i.counterparty_id, obligation_counterparty_id: o.counterparty_id });
      const control = input.controlAccounts.get(section);
      if (!control) add(section, 'incomplete_evidence', OB_CODES.controlAccountUnmapped, i);
      else if (!control.has(i.account_id)) add(section, 'blocked', OB_CODES.controlAccountMismatch, i, { account_id: i.account_id });
      if (i.balance_side !== naturalSide) add(section, 'mismatch', OB_CODES.obligationSideMismatch, i, { expected_side: naturalSide, actual_side: i.balance_side });
      const expected = toCents(o.original_amount), actual = toCents(i.amount);
      if (expected !== actual) add(section, 'mismatch', OB_CODES.obligationAmountMismatch, i, { expected: fromCents(expected), actual: fromCents(actual), difference: fromCents(actual - expected) });
    }
    // Totals are informational: nothing in the schema proves the opening obligation population complete, so a difference (including a
    // category with no items) is incomplete evidence, never a confirmed mismatch. One-to-one contradictions are reported per item above.
    const linkedIds = new Set(input.items.filter((x) => x.category === section && x.obligation_id).map((x) => x.obligation_id!));
    for (const o of input.openingObligations.filter((x) => x.direction === section && !linkedIds.has(x.id))) {
      add(section, 'incomplete_evidence', OB_CODES.subledgerUnlinkedObligation, undefined, { obligation_id: o.id, amount: o.original_amount });
    }
    if (glTotals[section] !== subledgerTotals[section]) {
      add(section, 'incomplete_evidence', OB_CODES.subledgerTotalDifference, undefined,
        { gl_total: fromCents(glTotals[section]), subledger_total: fromCents(subledgerTotals[section]), difference: fromCents(glTotals[section] - subledgerTotals[section]) });
    }
  }

  const sections = {} as Record<ReconciliationSection, ReconciliationSectionReport>;
  for (const s of ['bank', 'receivable', 'payable'] as const) {
    const own = issues.filter((x) => x.section === s);
    const status = own.reduce<ReconciliationStatus>((a, x) => worst(a, x.class), 'verified');
    const items = input.items.filter((x) => x.category === s);
    const gl = s === 'bank' ? items.reduce((a, x) => a + signed(x), 0n) : glTotals[s];
    sections[s] = { status, item_count: items.length, gl_total: fromCents(gl), subledger_total: s === 'bank' ? null : fromCents(subledgerTotals[s]) };
  }
  const status = (['bank', 'receivable', 'payable'] as const).reduce<ReconciliationStatus>((a, s) => worst(a, sections[s].status), 'verified');
  return { status, blocking: status === 'blocked' || status === 'mismatch', as_of_date: input.startDate, sections, issues };
}

/**
 * Loads the review's evidence with the caller's client and evaluates it. With `lock` (approval), the referenced obligations and
 * statements are share-locked and each bank account takes the statement advisory lock, so a concurrent cancel, supersede or
 * confirm is ordered strictly before or after this check. Reads only; writes nothing.
 */
export async function loadOpeningReconciliationInput(client: PoolClient, companyId: string, reviewId: string, startDate: string, lock = false): Promise<ReconciliationInput> {
  const share = lock ? ' FOR SHARE' : '';
  // An untouched row of the trial-balance import is the only genuine aggregate. The import writes its rows and its audit event in one
  // transaction, so they share the transaction timestamp; a hand-entered item has its own, and any later edit raises its version.
  const items = (await client.query<ReconciliationItem>(
    `SELECT i.id,i.category,i.account_id,i.amount::text,i.balance_side,i.counterparty_id,i.bank_account_id,i.obligation_id,
            CASE WHEN i.version=1 AND EXISTS (
                   SELECT 1 FROM audit_log a WHERE a.company_id=i.company_id AND a.action='opening_balance.import'
                      AND a.entity_type='opening_balance_review' AND a.entity_id=i.review_id AND a.created_at=i.created_at)
                 THEN 'import' ELSE 'manual' END AS provenance
       FROM opening_balance_items i WHERE i.company_id=$1 AND i.review_id=$2 ORDER BY i.created_at,i.id`,
    [companyId, reviewId])).rows;
  const linkRows = (await client.query<{ bank_account_id: string; account_id: string }>(
    `SELECT bank_account_id,account_id FROM bank_account_ledger_links WHERE company_id=$1 AND valid_from<=$2::date AND (valid_to IS NULL OR valid_to>=$2::date)`,
    [companyId, startDate])).rows;
  const bankLinks = new Map<string, string[]>();
  const bankLinksByAccount = new Map<string, string[]>();
  for (const r of linkRows) {
    bankLinks.set(r.bank_account_id, [...(bankLinks.get(r.bank_account_id) ?? []), r.account_id]);
    bankLinksByAccount.set(r.account_id, [...(bankLinksByAccount.get(r.account_id) ?? []), r.bank_account_id]);
  }
  const bankItemAccounts = new Set(items.filter((i) => i.category === 'bank' && !i.bank_account_id).map((i) => i.account_id));
  const bankIds = [...new Set([
    ...items.filter((i) => i.bank_account_id).map((i) => i.bank_account_id!),
    ...[...bankItemAccounts].flatMap((a) => bankLinksByAccount.get(a) ?? []),
  ])].sort();
  const obligationIds = [...new Set(items.filter((i) => i.obligation_id).map((i) => i.obligation_id!))];
  if (lock) for (const id of bankIds) await lockBankAccountReconciliation(client, companyId, id);

  const profile = (await client.query<{ functional_currency: string }>(
    `SELECT functional_currency FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$2::date AND (effective_to IS NULL OR effective_to>=$2::date)`,
    [companyId, startDate])).rows;
  const bankAccounts = new Map((await client.query<{ id: string; currency_code: string }>(
    'SELECT id,currency_code FROM bank_accounts WHERE company_id=$1 AND id=ANY($2::uuid[])', [companyId, bankIds])).rows.map((r) => [r.id, r]));
  const statements = new Map((await client.query<{ id: string; bank_account_id: string; closing_balance: string; currency_code: string }>(
    `SELECT id,bank_account_id,closing_balance::text,currency_code FROM bank_statement_balances WHERE company_id=$1 AND bank_account_id=ANY($2::uuid[]) AND status='confirmed' AND period_end=$3::date-1${share}`,
    [companyId, bankIds, startDate])).rows.map((r) => [r.bank_account_id, r]));
  const oblSql = 'SELECT id,direction,counterparty_id,original_amount::text,source_type,is_cancelled,recognized_on::text FROM obligations';
  const referencedObligations = new Map((await client.query<ReconciliationObligation>(
    `${oblSql} WHERE company_id=$1 AND id=ANY($2::uuid[])${share}`, [companyId, obligationIds])).rows.map((r) => [r.id, r]));
  const openingObligations = (await client.query<ReconciliationObligation>(
    `${oblSql} WHERE company_id=$1 AND source_type='opening_balance' AND NOT is_cancelled AND recognized_on=$2::date${share}`, [companyId, startDate])).rows;
  const controlAccounts = new Map<'receivable' | 'payable', Set<string>>();
  for (const key of ['receivable', 'payable'] as const) {
    const ids = (await client.query<{ id: string }>(
      `WITH RECURSIVE d AS (
         SELECT a.id FROM accounts a JOIN invoice_account_mappings m ON m.account_id=a.id AND m.company_id=a.company_id WHERE m.company_id=$1 AND m.mapping_key=$2
         UNION SELECT a.id FROM accounts a JOIN d ON a.parent_account_id=d.id WHERE a.company_id=$1)
       SELECT id FROM d`, [companyId, key])).rows;
    if (ids.length) controlAccounts.set(key, new Set(ids.map((r) => r.id)));
  }
  return {
    startDate, functionalCurrency: profile.length === 1 ? profile[0]!.functional_currency : null,
    items, bankAccounts, bankLinks, bankLinksByAccount, statements, referencedObligations, openingObligations, controlAccounts,
  };
}

export async function loadOpeningReconciliation(client: PoolClient, companyId: string, reviewId: string, startDate: string, lock = false): Promise<ReconciliationReport> {
  return evaluateOpeningReconciliation(await loadOpeningReconciliationInput(client, companyId, reviewId, startDate, lock));
}

export class OpeningBalanceReconciliationBlockedError extends Error {
  readonly code = OB_RECONCILIATION_BLOCKED_CODE;
  constructor(readonly report: ReconciliationReport) {
    super('Opening balance reconciliation found blocking issues');
  }
}

export async function assertOpeningReconciliation(client: PoolClient, companyId: string, reviewId: string, startDate: string, lock = false): Promise<ReconciliationReport> {
  const report = await loadOpeningReconciliation(client, companyId, reviewId, startDate, lock);
  if (report.blocking) throw new OpeningBalanceReconciliationBlockedError(report);
  return report;
}
