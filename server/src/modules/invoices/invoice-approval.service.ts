import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable, AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { assertFiscalYearOpen, FiscalYearClosedError } from '../accounting/fiscal-year-posting.guard';
import { InvoiceError } from './invoice.service';

/**
 * submitted -> approved: official internal number only.
 *
 * DORMANT BY DESIGN: no route calls this, and the invoice.approve capability is not registered. Final approval stays
 * disabled until the owner decides account mapping (A1), receivable/payable confirmation (A2) and VAT timing (A3/A5).
 * Approval here has NO obligation, journal or VAT effect, and never posts anything.
 *
 * One transaction: lock invoice row -> status/version -> separation of duties -> exactly one fiscal year by issue_date
 * -> period guard -> fiscal-year-open guard (same order as journal posting) -> atomic number -> update -> audit.
 * Any failure rolls back, so no number is consumed.
 */
export class InvoiceApprovalService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  /** allowSelfApproval defaults to false (strict separation of duties); the owner has not yet chosen the final rule. */
  async approve(companyId: string, actorUserId: string, invoiceId: string, expectedVersion: number, opts: { allowSelfApproval?: boolean } = {}) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await this.run(client, companyId, actorUserId, invoiceId, expectedVersion, opts.allowSelfApproval === true);
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

  private async run(client: PoolClient, companyId: string, actorUserId: string, invoiceId: string, expectedVersion: number, allowSelf: boolean) {
    const COLS = 'id, direction, status, version, issue_date::text AS issue_date, total_amount::text AS total_amount, created_by_user_id, internal_number::text AS internal_number, fiscal_year_id, approved_by_user_id, approved_at';
    const before = (await client.query(`SELECT ${COLS} FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`, [invoiceId, companyId])).rows[0];
    if (!before) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    if (before.status === 'approved') throw new InvoiceError(409, 'INVOICE_ALREADY_APPROVED', 'Invoice is already approved');
    if (before.status !== 'submitted') throw new InvoiceError(409, 'INVOICE_NOT_SUBMITTED', 'Only submitted invoices can be approved');
    if (before.version !== expectedVersion) throw new InvoiceError(409, 'INVOICE_VERSION_CONFLICT', 'The invoice was changed by someone else; reload and try again');
    if (!allowSelf && before.created_by_user_id === actorUserId) throw new InvoiceError(409, 'INVOICE_SELF_APPROVAL', 'The creator of an invoice cannot approve it');

    // Fiscal years may overlap in the data (no exclusion constraint), so require exactly one match.
    const years = (await client.query<{ id: string }>(
      'SELECT id FROM fiscal_years WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date', [companyId, before.issue_date])).rows;
    if (years.length !== 1) throw new InvoiceError(409, 'INVOICE_FISCAL_YEAR_UNRESOLVED', years.length === 0 ? 'No fiscal year covers the issue date' : 'More than one fiscal year covers the issue date');
    const fiscalYearId = years[0]!.id;

    await assertAccountingDateWritable(companyId, before.issue_date, client);
    await assertFiscalYearOpen(companyId, fiscalYearId, before.issue_date, client);

    const number = (await client.query<{ n: string }>('SELECT allocate_invoice_number($1, $2, $3)::text AS n', [companyId, before.direction, fiscalYearId])).rows[0]!.n;
    await client.query(
      `UPDATE invoices SET status = 'approved', internal_number = $3, fiscal_year_id = $4, approved_by_user_id = $5, approved_at = NOW(),
              version = version + 1, updated_at = NOW() WHERE id = $1 AND company_id = $2 AND status = 'submitted'`,
      [invoiceId, companyId, number, fiscalYearId, actorUserId]);
    const after = (await client.query(`SELECT ${COLS} FROM invoices WHERE id = $1 AND company_id = $2`, [invoiceId, companyId])).rows[0];
    await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.approve', entity_type: 'invoice', entity_id: invoiceId, before_data: before as never, after_data: after as never }, client);
    return after;
  }
}
