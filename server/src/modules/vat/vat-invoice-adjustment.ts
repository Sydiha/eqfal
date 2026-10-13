import type { Pool, PoolClient } from 'pg';
import { expectedVatLines, fromHalalas, InvoiceReconciliationStatus, InvoiceVatDirection, InvoiceVatGroup, toHalalas } from './vat-invoice';

/**
 * VAT side of externally issued credit / debit notes (F4 completion). Approved notes are reported by their issue date (== tax date): a credit note
 * REDUCES output VAT (sales) or input / recoverable VAT (purchases), a debit note increases it. Notes are only ever registered when the note date
 * and the original tax point date share one existing OPEN VAT period (see InvoiceAdjustmentService), so a note never lands in a different
 * or an already closed period than the invoice it corrects. Exact integer (halalas) arithmetic; no tolerance.
 */
type QueryRunner = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
export type AdjustmentType = 'credit' | 'debit';

export interface VatInvoiceAdjustmentRow {
  adjustment_id: string; adjustment_type: AdjustmentType; direction: InvoiceVatDirection; external_number: string; counterparty_name: string;
  original_invoice_id: string; original_internal_number: string | null; adjustment_date: string; tax_date: string;
  total_amount: string; taxable_amount: string; vat_amount: string;
  /** Purchases only: recoverable input VAT stated on the note (explicit per line). */
  recoverable_vat_amount?: string;
  journal_entry_id: string | null; journal_status: 'draft' | 'posted' | null; ledger_vat_amount: string | null;
  reconciliation_status: InvoiceReconciliationStatus; groups: InvoiceVatGroup[];
}

/** +1 for a debit note, -1 for a credit note: the sign of its effect on the invoice's output / input VAT and amounts. */
export const adjustmentSign = (type: AdjustmentType): bigint => (type === 'credit' ? -1n : 1n);

/** Where the VAT line sits in the note's own journal. Credit notes mirror the original invoice; debit notes follow it. */
function vatSide(direction: InvoiceVatDirection, type: AdjustmentType) {
  const original = direction === 'sales' ? 'credit' : 'debit';
  const side = type === 'credit' ? (original === 'credit' ? 'debit' : 'credit') : original;
  const pick = (l: { debit: string; credit: string }, wanted: 'debit' | 'credit') => toHalalas(wanted === 'debit' ? l.debit : l.credit);
  return {
    memo: direction === 'sales' ? 'VAT_OUTPUT' : 'VAT_INPUT', other: direction === 'sales' ? 'VAT_INPUT' : 'VAT_OUTPUT',
    accountType: direction === 'sales' ? 'liability' : 'asset',
    amount: (l: { debit: string; credit: string }) => pick(l, side), offside: (l: { debit: string; credit: string }) => pick(l, side === 'debit' ? 'credit' : 'debit'),
  } as const;
}

const GROUPS_SQL = `SELECT a.id adjustment_id, l.vat_treatment, l.vat_rate::text vat_rate, COUNT(*)::int line_count, SUM(l.net_amount)::text taxable_amount, SUM(l.vat_amount)::text vat_amount,
  SUM(line_recoverable(a.direction, l.vat_treatment, l.vat_amount, l.vat_recoverability, l.vat_recoverable_percent))::text recoverable_vat_amount
  FROM invoice_adjustments a JOIN invoice_adjustment_lines l ON l.adjustment_id=a.id AND l.company_id=a.company_id
  WHERE a.company_id=$1 AND a.id = ANY($2::uuid[]) GROUP BY a.id, l.vat_treatment, l.vat_rate ORDER BY l.vat_treatment, l.vat_rate`;

function toGroups(direction: InvoiceVatDirection, rows: Array<InvoiceVatGroup & { recoverable_vat_amount: string | null }>): InvoiceVatGroup[] {
  return rows.map(({ recoverable_vat_amount, ...g }) => (direction === 'purchase' ? { ...g, recoverable_vat_amount: recoverable_vat_amount ?? '0.00' } : g));
}

/** Approved notes dated in [start,end], with their exact reconciliation against their own POSTED journal. */
export async function loadInvoiceAdjustmentVat(db: QueryRunner, companyId: string, start: string, end: string): Promise<VatInvoiceAdjustmentRow[]> {
  const notes = (await db.query<{
    id: string; adjustment_type: AdjustmentType; direction: InvoiceVatDirection; external_number: string; counterparty_name: string; original_invoice_id: string;
    original_internal_number: string | null; adjustment_date: string; total_amount: string; subtotal_amount: string; vat_amount: string;
  }>(
    `SELECT a.id, a.adjustment_type, a.direction, a.external_number, c.name counterparty_name, a.original_invoice_id, i.internal_number::text original_internal_number,
            a.adjustment_date::text adjustment_date, a.total_amount::text total_amount, a.subtotal_amount::text subtotal_amount, a.vat_amount::text vat_amount
     FROM invoice_adjustments a JOIN counterparties c ON c.id=a.counterparty_id AND c.company_id=a.company_id
     JOIN invoices i ON i.id=a.original_invoice_id AND i.company_id=a.company_id
     WHERE a.company_id=$1 AND a.status='approved' AND a.adjustment_date BETWEEN $2 AND $3 ORDER BY a.adjustment_date, a.external_number, a.id`, [companyId, start, end])).rows;
  if (!notes.length) return [];
  const ids = notes.map((n) => n.id);
  const groups = (await db.query<InvoiceVatGroup & { adjustment_id: string; recoverable_vat_amount: string | null }>(GROUPS_SQL, [companyId, ids])).rows;
  const journals = (await db.query<{ id: string; source_id: string; status: 'draft' | 'posted' }>(
    `SELECT id, source_id, status FROM journal_entries WHERE company_id=$1 AND source_type='invoice_adjustment' AND source_id = ANY($2::uuid[])`, [companyId, ids])).rows;
  const memoLines = journals.length ? (await db.query<{ journal_entry_id: string; memo: string; debit: string; credit: string; account_type: string }>(
    `SELECT l.journal_entry_id, l.memo, l.debit::text debit, l.credit::text credit, a.account_type
     FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
     WHERE l.company_id=$1 AND l.journal_entry_id = ANY($2::uuid[]) AND l.memo IN ('VAT_INPUT','VAT_OUTPUT')`, [companyId, journals.map((j) => j.id)])).rows : [];

  return notes.map((note) => {
    const side = vatSide(note.direction, note.adjustment_type);
    const own = toGroups(note.direction, groups.filter((g) => g.adjustment_id === note.id).map(({ adjustment_id: _ignored, ...g }) => g));
    const journal = journals.find((j) => j.source_id === note.id) ?? null;
    const recoverable = own.reduce((s, g) => s + toHalalas(g.recoverable_vat_amount), 0n);
    const base = {
      adjustment_id: note.id, adjustment_type: note.adjustment_type, direction: note.direction, external_number: note.external_number, counterparty_name: note.counterparty_name,
      original_invoice_id: note.original_invoice_id, original_internal_number: note.original_internal_number, adjustment_date: note.adjustment_date, tax_date: note.adjustment_date,
      total_amount: note.total_amount, taxable_amount: note.subtotal_amount, vat_amount: note.vat_amount,
      ...(note.direction === 'purchase' ? { recoverable_vat_amount: fromHalalas(recoverable) } : {}),
      journal_entry_id: journal?.id ?? null, journal_status: journal?.status ?? null, groups: own,
    };
    if (!journal || journal.status !== 'posted') return { ...base, ledger_vat_amount: null, reconciliation_status: 'missing_posted_journal' as const };
    const lines = memoLines.filter((l) => l.journal_entry_id === journal.id);
    const vatLines = lines.filter((l) => l.memo === side.memo);
    const ledger = vatLines.length ? fromHalalas(vatLines.reduce((sum, l) => sum + side.amount(l), 0n)) : null;
    const wrong = lines.some((l) => l.memo === side.other) || vatLines.some((l) => !(l.account_type === side.accountType && side.amount(l) > 0n && side.offside(l) === 0n));
    if (wrong) return { ...base, ledger_vat_amount: ledger, reconciliation_status: 'wrong_vat_direction' as const };
    const expected = expectedVatLines(own);
    const actual = vatLines.map((l) => side.amount(l)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let status: InvoiceReconciliationStatus;
    if (!expected.length) status = actual.length === 0 ? 'reconciled' : 'vat_amount_mismatch';
    else if (!actual.length) status = 'missing_vat_line';
    else status = expected.length === actual.length && expected.every((v, i) => v === actual[i]) ? 'reconciled' : 'vat_amount_mismatch';
    return { ...base, ledger_vat_amount: ledger, reconciliation_status: status };
  });
}

/** Posting-time verification (inside the posting transaction): the note's VAT lines must match its approved lines exactly. Returns false when not exact. */
export async function invoiceAdjustmentJournalIsExact(client: QueryRunner, companyId: string, journalId: string, adjustmentId: string): Promise<boolean> {
  const note = (await client.query<{ adjustment_type: AdjustmentType; direction: InvoiceVatDirection; status: string }>(
    'SELECT adjustment_type, direction, status FROM invoice_adjustments WHERE id=$1 AND company_id=$2', [adjustmentId, companyId])).rows[0];
  if (!note || note.status !== 'approved') return false;
  const side = vatSide(note.direction, note.adjustment_type);
  const own = toGroups(note.direction, (await client.query<InvoiceVatGroup & { adjustment_id: string; recoverable_vat_amount: string | null }>(GROUPS_SQL, [companyId, [adjustmentId]])).rows.map(({ adjustment_id: _ignored, ...g }) => g));
  const lines = (await client.query<{ memo: string; debit: string; credit: string; account_type: string }>(
    `SELECT l.memo, l.debit::text debit, l.credit::text credit, a.account_type
     FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
     WHERE l.company_id=$1 AND l.journal_entry_id=$2 AND l.memo IN ('VAT_INPUT','VAT_OUTPUT')`, [companyId, journalId])).rows;
  if (lines.some((l) => l.memo !== side.memo || l.account_type !== side.accountType || side.offside(l) !== 0n || side.amount(l) <= 0n)) return false;
  const expected = expectedVatLines(own);
  const actual = lines.map((l) => side.amount(l)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return expected.length === actual.length && expected.every((v, i) => v === actual[i]);
}
