import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable, AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { assertFiscalYearOpen, FiscalYearClosedError } from '../accounting/fiscal-year-posting.guard';
import { loadValidMappings, requiredKeys } from './invoice-account-mapping.service';
import { InvoiceError } from './invoice.service';
import { lockVatDates } from '../vat/vat.router';
import { fromHalalas, groupInvoiceLines, InvoiceVatGroup, InvoiceVatTreatment, purchaseLineRecoverable, toHalalas } from '../vat/vat-invoice';

/**
 * submitted -> approved, atomically with its confirmed obligation (A2) and balanced DRAFT journal (A1).
 *
 * Exposed by POST /invoices/:id/approve (F1) behind the explicit-grant-only invoice.approve capability (migration 070); no grants exist.
 * The journal is never posted here. V1 (sales): approval also writes the immutable reviewed VAT snapshot (header + one group per
 * treatment and rate) and stamps one VAT_OUTPUT line per standard-rate group. V2 (purchases): the same snapshot, with one VAT_INPUT
 * debit line per standard-rate group for the RECOVERABLE part only (V2.1: the creator's explicit per-line recovery; the non-recoverable
 * part is capitalized into the single expense debit; asset purchases are unsupported; nothing is inferred or defaulted).
 *
 * One transaction, all or nothing: lock invoice -> status/version -> permissions (holding them is enough, the creator included) -> exactly one
 * open fiscal year by issue_date -> period guard -> fiscal-year guard -> mappings -> number -> invoice update ->
 * obligation -> draft journal + lines -> audit. Any failure rolls back, so no number, obligation or journal remains.
 */
/**
 * Approval is authorized by invoice.approve alone (owner decision 2026-10-15). The confirmed obligation, the DRAFT journal and
 * the VAT review are system-generated effects of the approved business operation, so the approver does NOT need
 * obligation.confirm or accounting.journal.create. Manual journal creation and posting stay separately controlled.
 */
export const APPROVAL_REQUIRED_CAPABILITIES = ['invoice.approve'] as const;

type Header = {
  id: string; direction: 'sales' | 'purchase'; status: string; version: number; counterparty_id: string; issue_date: string; due_date: string | null;
  subtotal_amount: string; vat_amount: string; total_amount: string; created_by_user_id: string;
  internal_number: string | null; fiscal_year_id: string | null; approved_by_user_id: string | null; approved_at: string | null;
  tax_point_date: string | null;
};
const COLS = `id, direction, status, version, counterparty_id, issue_date::text AS issue_date, due_date::text AS due_date,
  subtotal_amount::text AS subtotal_amount, vat_amount::text AS vat_amount, total_amount::text AS total_amount, created_by_user_id,
  internal_number::text AS internal_number, fiscal_year_id, approved_by_user_id, approved_at, tax_point_date::text AS tax_point_date`;

export class InvoiceApprovalService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  async approve(companyId: string, actorUserId: string, actorCapabilities: readonly string[], invoiceId: string, expectedVersion: number) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await this.run(client, companyId, actorUserId, actorCapabilities, invoiceId, expectedVersion);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof AccountingPeriodClosedError) throw new InvoiceError(409, 'INVOICE_PERIOD_CLOSED', 'The accounting period of the issue date is closed');
      if (error instanceof FiscalYearClosedError) throw new InvoiceError(409, 'INVOICE_FISCAL_YEAR_CLOSED', 'The fiscal year of the issue date is closed');
      throw error;
    } finally {
      client.release();
    }
  }

  private async run(client: PoolClient, companyId: string, actorUserId: string, caps: readonly string[], invoiceId: string, expectedVersion: number) {
    const before = (await client.query<Header>(`SELECT ${COLS} FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`, [invoiceId, companyId])).rows[0];
    if (!before) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    if (before.status === 'approved') throw new InvoiceError(409, 'INVOICE_ALREADY_APPROVED', 'Invoice is already approved');
    if (before.status !== 'submitted') throw new InvoiceError(409, 'INVOICE_NOT_SUBMITTED', 'Only submitted invoices can be approved');
    if (before.version !== expectedVersion) throw new InvoiceError(409, 'INVOICE_VERSION_CONFLICT', 'The invoice was changed by someone else; reload and try again');
    const missingCaps = APPROVAL_REQUIRED_CAPABILITIES.filter((c) => !caps.includes(c));
    if (missingCaps.length) throw new InvoiceError(403, 'INVOICE_FORBIDDEN', `Approval requires: ${missingCaps.join(', ')}`);
    if (!(Number(before.total_amount) > 0)) throw new InvoiceError(409, 'INVOICE_EMPTY', 'An invoice with a zero total cannot be approved');
    const hasVat = Number(before.vat_amount) > 0;

    // Explicit tax point + explicit line treatments (V1 sales, V2 purchases), verified here by the independent approver. Nothing is
    // inferred. Purchases: every standard-rated line also states its input VAT recoverability; V2 supports full recovery only.
    const vatLines = (await client.query<{ vat_treatment: InvoiceVatTreatment | null; vat_rate: string; net_amount: string; vat_amount: string; vat_recoverability: string | null; vat_recoverable_percent: string | null }>(
      'SELECT vat_treatment, vat_rate::text AS vat_rate, net_amount::text AS net_amount, vat_amount::text AS vat_amount, vat_recoverability, vat_recoverable_percent::text AS vat_recoverable_percent FROM invoice_lines WHERE invoice_id = $1 AND company_id = $2 ORDER BY line_number', [invoiceId, companyId])).rows;
    if (!before.tax_point_date || !vatLines.length || vatLines.some((l) => !l.vat_treatment)) {
      throw new InvoiceError(409, 'INVOICE_VAT_INCOMPLETE', `A ${before.direction} invoice needs a tax point date and an explicit VAT treatment on every line`);
    }
    if (before.direction === 'sales' && vatLines.some((l) => l.vat_recoverability !== null || l.vat_recoverable_percent !== null)) {
      throw new InvoiceError(409, 'INVOICE_VAT_INCOMPLETE', 'Sales VAT has no recoverability');
    }
    // Purchases: the recoverable part of every line comes only from its explicit statement; a missing or incoherent one blocks approval.
    const recoverableByLine = vatLines.map((l) => (before.direction === 'purchase'
      ? purchaseLineRecoverable({ vat_treatment: l.vat_treatment!, vat_amount: l.vat_amount, vat_recoverability: l.vat_recoverability, vat_recoverable_percent: l.vat_recoverable_percent })
      : undefined));
    if (recoverableByLine.some((r) => r === null)) {
      throw new InvoiceError(409, 'INVOICE_VAT_INCOMPLETE', 'Every standard-rated purchase line needs an explicit, valid VAT recoverability (and a percent when partial)');
    }
    const groups: InvoiceVatGroup[] = groupInvoiceLines(vatLines.map((l, i) => ({ ...l, vat_treatment: l.vat_treatment!, recoverable_vat_halalas: recoverableByLine[i] ?? undefined })));
    const recoverableTotalH = groups.reduce((sum, g) => sum + toHalalas(g.recoverable_vat_amount), 0n);
    const recoverableTotal = fromHalalas(recoverableTotalH);
    // Non-recoverable input VAT is capitalized into the related expense cost (owner policy 2026-10-12).
    const expenseDebit = fromHalalas(toHalalas(before.subtotal_amount) + toHalalas(before.vat_amount) - recoverableTotalH);

    const cp = (await client.query<{ is_active: boolean }>('SELECT is_active FROM counterparties WHERE id = $1 AND company_id = $2', [before.counterparty_id, companyId])).rows[0];
    if (!cp || !cp.is_active) throw new InvoiceError(400, 'INVOICE_COUNTERPARTY_INVALID', 'Counterparty not found or inactive');

    // Fiscal years may overlap in the data (no exclusion constraint): require exactly one, and it must be open.
    const years = (await client.query<{ id: string }>(
      'SELECT id FROM fiscal_years WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date', [companyId, before.issue_date])).rows;
    if (years.length !== 1) throw new InvoiceError(409, 'INVOICE_FISCAL_YEAR_UNRESOLVED', years.length === 0 ? 'No fiscal year covers the issue date' : 'More than one fiscal year covers the issue date');
    const fiscalYearId = years[0]!.id;
    // Lock order, shared with journal posting, VAT review writes, custody allocation and fiscal-year close:
    //   fiscal-year row -> document row -> VAT month lock -> accounting month lock.
    // Every other writer takes them in this order, so approval must too (any other order can deadlock against them).
    await assertFiscalYearOpen(companyId, fiscalYearId, before.issue_date, client);
    const linked = (await client.query<{ document_id: string }>('SELECT document_id FROM invoice_source_links WHERE invoice_id = $1 AND company_id = $2', [invoiceId, companyId])).rows[0];
    if (linked) await client.query('SELECT 1 FROM documents WHERE id = $1 AND company_id = $2 FOR UPDATE', [linked.document_id, companyId]);
    await lockVatDates(companyId, [before.tax_point_date!], client);
    await assertAccountingDateWritable(companyId, before.issue_date, client);

    {
      // The VAT month lock was taken above, before any closed-period read.
      if ((await client.query("SELECT 1 FROM vat_periods WHERE company_id = $1 AND status = 'closed' AND $2::date BETWEEN period_start AND period_end LIMIT 1", [companyId, before.tax_point_date])).rowCount) {
        throw new InvoiceError(409, 'INVOICE_VAT_PERIOD_CLOSED', 'The tax point date falls in a closed VAT period');
      }
      await assertAccountingDateWritable(companyId, before.tax_point_date!, client);
    }
    // A linked document is evidence only. If it already carries its own VAT, obligation or custody allocation, the invoice must not recognize it again.
    if (linked) {
      const recognized = await client.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM document_vat_reviews WHERE document_id = $1 AND company_id = $2 AND review_status = 'reviewed')
            OR EXISTS (SELECT 1 FROM obligations WHERE document_id = $1 AND company_id = $2 AND source_type = 'document' AND NOT is_cancelled)
            OR EXISTS (SELECT 1 FROM custody_document_allocations WHERE document_id = $1 AND company_id = $2)`, [linked.document_id, companyId]);
      if (recognized.rowCount) throw new InvoiceError(409, 'INVOICE_DOCUMENT_ALREADY_RECOGNIZED', 'The linked document is already recognized on its own and cannot also be recognized through this invoice');
    }

    const mapped = await loadValidMappings(client, companyId);
    // A purchase needs the input-VAT account only when some VAT is actually recoverable (a fully non-recoverable VAT has no VAT_INPUT line).
    const needed = requiredKeys(before.direction, before.direction === 'sales' ? hasVat : recoverableTotalH > 0n);
    const missing = needed.filter((k) => !mapped[k]);
    if (missing.length) throw new InvoiceError(409, 'INVOICE_MAPPING_MISSING', `Missing or invalid account mappings: ${missing.join(', ')}`);

    const number = (await client.query<{ n: string }>('SELECT allocate_invoice_number($1, $2, $3)::text AS n', [companyId, before.direction, fiscalYearId])).rows[0]!.n;
    await client.query(
      `UPDATE invoices SET status = 'approved', internal_number = $3, fiscal_year_id = $4, approved_by_user_id = $5, approved_at = NOW(),
              version = version + 1, updated_at = NOW() WHERE id = $1 AND company_id = $2 AND status = 'submitted'`,
      [invoiceId, companyId, number, fiscalYearId, actorUserId]);
    const after = (await client.query<Header>(`SELECT ${COLS} FROM invoices WHERE id = $1 AND company_id = $2`, [invoiceId, companyId])).rows[0]!;

    const obligation = (await client.query(
      `INSERT INTO obligations (company_id, direction, counterparty_id, invoice_id, original_amount, recognized_on, due_on, verification_status, source_type, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed','invoice',$8) RETURNING *, original_amount::text, recognized_on::text, due_on::text`,
      [companyId, before.direction === 'sales' ? 'receivable' : 'payable', before.counterparty_id, invoiceId, before.total_amount, before.issue_date, before.due_date, actorUserId])).rows[0];

    const label = `${before.direction === 'sales' ? 'Sales' : 'Purchase'} invoice ${number}`;
    const journal = (await client.query(
      `INSERT INTO journal_entries (company_id, fiscal_year_id, accounting_date, description, reference, source_type, source_id, entry_type, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'obligation',$6,'standard','draft',$7) RETURNING *, accounting_date::text`,
      [companyId, fiscalYearId, before.issue_date, label, label, obligation.id, actorUserId])).rows[0];
    // Sales: Dr receivable total / Cr revenue subtotal / Cr VAT output per standard-rate group.
    // Purchase: Dr expense (subtotal + non-recoverable VAT) / Dr VAT input (recoverable part) per standard-rate group / Cr payable total.
    // One VAT line per standard-rate group with VAT (equal amounts stay separate lines), stamped VAT_OUTPUT or VAT_INPUT.
    const vatGroups = groups.filter((g) => g.vat_treatment === 'standard' && toHalalas(before.direction === 'sales' ? g.vat_amount : g.recoverable_vat_amount) > 0n);
    const lines: Array<[string, string, string, string | null]> = before.direction === 'sales'
      ? [[mapped.receivable!, before.total_amount, '0', null], [mapped.sales_revenue!, '0', before.subtotal_amount, null],
        ...vatGroups.map((g) => [mapped.vat_output!, '0', g.vat_amount, 'VAT_OUTPUT'] as [string, string, string, string])]
      : [[mapped.purchase_expense!, expenseDebit, '0', null],
        ...vatGroups.map((g) => [mapped.vat_input!, g.recoverable_vat_amount!, '0', 'VAT_INPUT'] as [string, string, string, string]),
        [mapped.payable!, '0', before.total_amount, null]];
    for (const [i, [account, debit, credit, memo]] of lines.entries()) {
      await client.query('INSERT INTO journal_lines (company_id, journal_entry_id, account_id, debit, credit, sequence, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [companyId, journal.id, account, debit, credit, i + 1, memo]);
    }
    const balanced = (await client.query<{ ok: boolean }>(
      'SELECT SUM(debit) = SUM(credit) AND SUM(debit) = $3::numeric AS ok FROM journal_lines WHERE journal_entry_id = $1 AND company_id = $2',
      [journal.id, companyId, before.total_amount])).rows[0]!.ok;
    if (!balanced) throw new Error('Invoice draft journal is not balanced');

    // Immutable reviewed VAT snapshot. Purchases (V2.1): recoverable VAT is the exact sum of the explicit per-line recovery on every group and on the header.
    const purchase = before.direction === 'purchase';
    const vatReviewId = (await client.query<{ id: string }>(
      `INSERT INTO invoice_vat_reviews (company_id, invoice_id, direction, tax_date, taxable_amount, vat_amount, reviewed_by_user_id, recoverable_vat_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [companyId, invoiceId, before.direction, before.tax_point_date, before.subtotal_amount, before.vat_amount, actorUserId, purchase ? recoverableTotal : null])).rows[0]!.id;
    for (const g of groups) {
      await client.query(
        `INSERT INTO invoice_vat_review_groups (company_id, review_id, vat_treatment, vat_rate, line_count, taxable_amount, vat_amount, recoverable_vat_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [companyId, vatReviewId, g.vat_treatment, g.vat_rate, g.line_count, g.taxable_amount, g.vat_amount, purchase ? g.recoverable_vat_amount! : null]);
    }
    await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.vat_review.create', entity_type: 'invoice_vat_review', entity_id: vatReviewId, before_data: null,
      after_data: { invoice_id: invoiceId, tax_date: before.tax_point_date, taxable_amount: before.subtotal_amount, vat_amount: before.vat_amount, groups,
        ...(purchase ? { direction: 'purchase', recoverable_vat_amount: recoverableTotal } : {}) } as never }, client);
    await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.approve', entity_type: 'invoice', entity_id: invoiceId, before_data: before as never, after_data: after as never }, client);
    await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'obligation.create', entity_type: 'obligation', entity_id: obligation.id, before_data: null, after_data: obligation as never }, client);
    await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'journal.create', entity_type: 'journal_entry', entity_id: journal.id, before_data: null, after_data: { ...journal, lines: lines.map(([account, debit, credit]) => [account, debit, credit]) } as never }, client);
    return { invoice: after, obligation_id: obligation.id as string, journal_id: journal.id as string, vat_review_id: vatReviewId };
  }
}
