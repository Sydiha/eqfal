import type { Pool, PoolClient } from 'pg';
import { parseRecoverablePercent, recoverablePortion } from '../invoices/invoice-math';

/**
 * Invoice side of VAT reporting and reconciliation (V1: sales invoices, output VAT; V2: purchase invoices, input VAT). Documents keep their own, untouched paths in
 * vat-report.ts / vat-reconciliation.ts; this module only ADDS invoice rows. All money is compared as exact integers of
 * halalas, never as floating point, and there is no tolerance: any difference is reported as a mismatch.
 */
type QueryRunner = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
export type InvoiceVatTreatment = 'standard' | 'zero_rated' | 'exempt' | 'out_of_scope';
export type InvoiceReconciliationStatus = 'reconciled' | 'missing_posted_journal' | 'missing_vat_line' | 'wrong_vat_direction' | 'vat_amount_mismatch';

export function toHalalas(value: string | null | undefined): bigint {
  if (value == null) return 0n;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const halalas = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0');
  return negative ? -halalas : halalas;
}
export function fromHalalas(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export interface InvoiceVatGroup {
  vat_treatment: InvoiceVatTreatment; vat_rate: string; line_count: number; taxable_amount: string; vat_amount: string;
  /** Purchases only (V2); absent on sales groups so they keep their V1 shape. */
  recoverable_vat_amount?: string;
}

export type PurchaseRecoverability = 'fully_recoverable' | 'non_recoverable' | 'partially_recoverable';
export interface RecoverabilityLine { vat_treatment: InvoiceVatTreatment; vat_amount: string; vat_recoverability: string | null; vat_recoverable_percent: string | null }

/**
 * Recoverable input VAT (halalas) of one purchase line, from its EXPLICIT stated recovery only. Returns null when the statement is
 * missing or incoherent (so callers reject instead of defaulting). Non-standard lines carry no VAT, hence no recovery.
 */
export function purchaseLineRecoverable(line: RecoverabilityLine): bigint | null {
  if (line.vat_treatment !== 'standard') return line.vat_recoverability === null && line.vat_recoverable_percent === null ? 0n : null;
  const vat = toHalalas(line.vat_amount);
  switch (line.vat_recoverability) {
    case 'fully_recoverable': return line.vat_recoverable_percent === null ? vat : null;
    case 'non_recoverable': return line.vat_recoverable_percent === null ? 0n : null;
    case 'partially_recoverable': {
      if (line.vat_recoverable_percent === null) return null;
      try { return recoverablePortion(vat, parseRecoverablePercent(line.vat_recoverable_percent)); } catch { return null; }
    }
    default: return null;
  }
}

/** Groups invoice lines by (treatment, rate); sums are exact. The result is deterministic (treatment, then rate). When lines carry a recoverable amount (purchases) the group carries the exact sum. */
export function groupInvoiceLines(lines: ReadonlyArray<{ vat_treatment: InvoiceVatTreatment; vat_rate: string; net_amount: string; vat_amount: string; recoverable_vat_halalas?: bigint }>): InvoiceVatGroup[] {
  const map = new Map<string, { vat_treatment: InvoiceVatTreatment; vat_rate: string; n: number; net: bigint; vat: bigint; rec: bigint | null }>();
  for (const line of lines) {
    const rate = Number(line.vat_rate).toFixed(2);
    const key = `${line.vat_treatment}|${rate}`;
    const group = map.get(key) ?? { vat_treatment: line.vat_treatment, vat_rate: rate, n: 0, net: 0n, vat: 0n, rec: null };
    group.n += 1; group.net += toHalalas(line.net_amount); group.vat += toHalalas(line.vat_amount);
    if (line.recoverable_vat_halalas !== undefined) group.rec = (group.rec ?? 0n) + line.recoverable_vat_halalas;
    map.set(key, group);
  }
  return [...map.values()]
    .sort((a, b) => (a.vat_treatment === b.vat_treatment ? Number(a.vat_rate) - Number(b.vat_rate) : a.vat_treatment < b.vat_treatment ? -1 : 1))
    .map((g) => ({ vat_treatment: g.vat_treatment, vat_rate: g.vat_rate, line_count: g.n, taxable_amount: fromHalalas(g.net), vat_amount: fromHalalas(g.vat),
      ...(g.rec === null ? {} : { recoverable_vat_amount: fromHalalas(g.rec) }) }));
}

/**
 * VAT amounts (halalas) that must appear as one VAT line each (VAT_OUTPUT for sales, VAT_INPUT for purchases): standard groups with a
 * positive amount. Purchases recognize only the RECOVERABLE part (a fully non-recoverable group has no VAT_INPUT line at all).
 */
export function expectedVatLines(groups: ReadonlyArray<InvoiceVatGroup>): bigint[] {
  return groups.filter((g) => g.vat_treatment === 'standard').map((g) => toHalalas(g.recoverable_vat_amount ?? g.vat_amount)).filter((v) => v > 0n)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * SQL predicate (alias `d` = documents). True when the document is linked to an APPROVED invoice and has no recognition of its
 * own. Legacy documents are never matched: they have no approved invoice, and an already-recognized document is never excluded.
 */
export const DOCUMENT_CARRIED_BY_APPROVED_INVOICE = `(
  EXISTS (SELECT 1 FROM invoice_source_links il JOIN invoices ii ON ii.id=il.invoice_id AND ii.company_id=il.company_id AND ii.status='approved'
          WHERE il.document_id=d.id AND il.company_id=d.company_id)
  AND NOT EXISTS (SELECT 1 FROM document_vat_reviews xr WHERE xr.document_id=d.id AND xr.company_id=d.company_id AND xr.review_status='reviewed')
  AND NOT EXISTS (SELECT 1 FROM obligations xo WHERE xo.document_id=d.id AND xo.company_id=d.company_id AND xo.source_type='document' AND NOT xo.is_cancelled))`;

export type InvoiceVatDirection = 'sales' | 'purchase';
/** Expected VAT line per direction: sales = output VAT, liability credit; purchases = recoverable input VAT, asset debit. */
const VAT_SIDE = {
  sales: { memo: 'VAT_OUTPUT', other: 'VAT_INPUT', accountType: 'liability', amount: (l: { debit: string; credit: string }) => toHalalas(l.credit), offside: (l: { debit: string; credit: string }) => toHalalas(l.debit) },
  purchase: { memo: 'VAT_INPUT', other: 'VAT_OUTPUT', accountType: 'asset', amount: (l: { debit: string; credit: string }) => toHalalas(l.debit), offside: (l: { debit: string; credit: string }) => toHalalas(l.credit) },
} as const;

export interface VatReportInvoiceGroup extends InvoiceVatGroup {}
export interface VatInvoiceReconciliationRow {
  invoice_id: string; internal_number: string | null; counterparty_name: string; issue_date: string; tax_date: string;
  total_amount: string; taxable_amount: string; reviewed_vat_amount: string; expected_memo: 'VAT_OUTPUT' | 'VAT_INPUT';
  /** Present only on purchase invoices (V2), so sales rows keep their V1 shape. Recoverable input VAT (V2.1: from the explicit per-line recovery, at most the reviewed VAT). */
  direction?: 'purchase'; recoverable_vat_amount?: string;
  obligation_id: string | null; journal_entry_id: string | null; journal_status: 'draft' | 'posted' | null;
  ledger_vat_amount: string | null; reconciliation_status: InvoiceReconciliationStatus; groups: VatReportInvoiceGroup[];
}

type Basis = 'tax_date' | 'issue_date';

/** Reviewed invoices (sales and purchases) in [start,end] (by tax date or issue date) with their exact reconciliation against the posted journal. */
export async function loadInvoiceVatReconciliation(db: QueryRunner, companyId: string, start: string, end: string, basis: Basis = 'tax_date'): Promise<VatInvoiceReconciliationRow[]> {
  const column = basis === 'tax_date' ? 'r.tax_date' : 'i.issue_date';
  const reviews = (await db.query<{
    review_id: string; invoice_id: string; internal_number: string | null; counterparty_name: string; issue_date: string; tax_date: string;
    total_amount: string; taxable_amount: string; vat_amount: string; obligation_id: string | null; direction: InvoiceVatDirection; recoverable_vat_amount: string | null;
  }>(
    `SELECT r.id review_id, r.direction, r.recoverable_vat_amount::text recoverable_vat_amount, i.id invoice_id, i.internal_number::text internal_number, c.name counterparty_name, i.issue_date::text issue_date, r.tax_date::text tax_date,
            i.total_amount::text total_amount, r.taxable_amount::text taxable_amount, r.vat_amount::text vat_amount,
            (SELECT o.id FROM obligations o WHERE o.company_id=i.company_id AND o.invoice_id=i.id AND o.source_type='invoice'
               AND NOT o.is_cancelled AND o.verification_status='confirmed' LIMIT 1) obligation_id
     FROM invoice_vat_reviews r
     JOIN invoices i ON i.id=r.invoice_id AND i.company_id=r.company_id
     JOIN counterparties c ON c.id=i.counterparty_id AND c.company_id=i.company_id
     WHERE r.company_id=$1 AND ${column} BETWEEN $2 AND $3
     ORDER BY ${column}, i.internal_number, i.id`, [companyId, start, end])).rows;
  if (!reviews.length) return [];

  const groups = (await db.query<InvoiceVatGroup & { review_id: string }>(
    `SELECT review_id, vat_treatment, vat_rate::text vat_rate, line_count, taxable_amount::text taxable_amount, vat_amount::text vat_amount,
            recoverable_vat_amount::text recoverable_vat_amount
     FROM invoice_vat_review_groups WHERE company_id=$1 AND review_id = ANY($2::uuid[]) ORDER BY vat_treatment, vat_rate`, [companyId, reviews.map((r) => r.review_id)])).rows
    .map(({ recoverable_vat_amount, ...g }) => (recoverable_vat_amount == null ? g : { ...g, recoverable_vat_amount }));
  const obligationIds = reviews.map((r) => r.obligation_id).filter((x): x is string => !!x);
  const journals = obligationIds.length ? (await db.query<{ id: string; source_id: string; status: 'draft' | 'posted' }>(
    `SELECT id, source_id, status FROM journal_entries WHERE company_id=$1 AND source_type='obligation' AND source_id = ANY($2::uuid[])
     ORDER BY (status='posted') DESC, created_at`, [companyId, obligationIds])).rows : [];
  const memoLines = journals.length ? (await db.query<{ journal_entry_id: string; memo: string; debit: string; credit: string; account_type: string }>(
    `SELECT l.journal_entry_id, l.memo, l.debit::text debit, l.credit::text credit, a.account_type
     FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
     WHERE l.company_id=$1 AND l.journal_entry_id = ANY($2::uuid[]) AND l.memo IN ('VAT_INPUT','VAT_OUTPUT')`, [companyId, journals.map((j) => j.id)])).rows : [];

  return reviews.map((review) => {
    const side = VAT_SIDE[review.direction];
    const own = groups.filter((g) => g.review_id === review.review_id).map(({ review_id: _ignored, ...g }) => g);
    const journal = review.obligation_id ? journals.find((j) => j.source_id === review.obligation_id) ?? null : null;
    const base = {
      invoice_id: review.invoice_id, internal_number: review.internal_number, counterparty_name: review.counterparty_name,
      issue_date: review.issue_date, tax_date: review.tax_date, total_amount: review.total_amount, taxable_amount: review.taxable_amount,
      reviewed_vat_amount: review.vat_amount, expected_memo: side.memo, obligation_id: review.obligation_id,
      journal_entry_id: journal?.id ?? null, journal_status: journal?.status ?? null, groups: own,
      ...(review.direction === 'purchase' ? { direction: 'purchase' as const, recoverable_vat_amount: review.recoverable_vat_amount ?? '0.00' } : {}),
    };
    if (!journal || journal.status !== 'posted') return { ...base, ledger_vat_amount: null, reconciliation_status: 'missing_posted_journal' as const };
    const lines = memoLines.filter((l) => l.journal_entry_id === journal.id);
    const outputs = lines.filter((l) => l.memo === side.memo);
    const ledger = outputs.length ? fromHalalas(outputs.reduce((sum, l) => sum + side.amount(l), 0n)) : null;
    const wrong = lines.some((l) => l.memo === side.other) || outputs.some((l) => !(l.account_type === side.accountType && side.amount(l) > 0n && side.offside(l) === 0n));
    if (wrong) return { ...base, ledger_vat_amount: ledger, reconciliation_status: 'wrong_vat_direction' as const };
    // Purchases: only recoverable input VAT is recognized (V2.1: the explicit recoverable part, enforced by the snapshot constraints).
    const expected = expectedVatLines(own);
    const actual = outputs.map((l) => side.amount(l)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let status: InvoiceReconciliationStatus;
    if (!expected.length) status = actual.length === 0 ? 'reconciled' : 'vat_amount_mismatch';
    else if (!actual.length) status = 'missing_vat_line';
    else status = expected.length === actual.length && expected.every((v, i) => v === actual[i]) ? 'reconciled' : 'vat_amount_mismatch';
    // Belt and braces: the reviewed total itself must equal the sum of the groups, with no tolerance.
    if (status === 'reconciled' && own.reduce((s, g) => s + toHalalas(g.vat_amount), 0n) !== toHalalas(review.vat_amount)) status = 'vat_amount_mismatch';
    return { ...base, ledger_vat_amount: ledger, reconciliation_status: status };
  });
}

/** Posting-time verification (called inside the posting transaction). Throws nothing itself: returns false when not exact. */
export async function invoiceVatRecognitionIsExact(client: QueryRunner, companyId: string, journalId: string, invoiceId: string): Promise<boolean> {
  const review = (await client.query<{ id: string; direction: InvoiceVatDirection }>('SELECT id, direction FROM invoice_vat_reviews WHERE invoice_id=$1 AND company_id=$2', [invoiceId, companyId])).rows[0];
  if (!review) return false;
  const side = VAT_SIDE[review.direction];
  const groups = (await client.query<InvoiceVatGroup>(
    `SELECT vat_treatment, vat_rate::text vat_rate, line_count, taxable_amount::text taxable_amount, vat_amount::text vat_amount, recoverable_vat_amount::text recoverable_vat_amount
     FROM invoice_vat_review_groups WHERE review_id=$1 AND company_id=$2`, [review.id, companyId])).rows
    .map(({ recoverable_vat_amount, ...g }) => (recoverable_vat_amount == null ? g : { ...g, recoverable_vat_amount }));
  const lines = (await client.query<{ memo: string; debit: string; credit: string; account_type: string }>(
    `SELECT l.memo, l.debit::text debit, l.credit::text credit, a.account_type
     FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
     WHERE l.company_id=$1 AND l.journal_entry_id=$2 AND l.memo IN ('VAT_INPUT','VAT_OUTPUT')`, [companyId, journalId])).rows;
  if (lines.some((l) => l.memo !== side.memo || l.account_type !== side.accountType || side.offside(l) !== 0n || side.amount(l) <= 0n)) return false;
  const expected = expectedVatLines(groups);
  const actual = lines.map((l) => side.amount(l)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return expected.length === actual.length && expected.every((v, i) => v === actual[i]);
}
