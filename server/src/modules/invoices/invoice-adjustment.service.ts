import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable, AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { assertFiscalYearOpen, FiscalYearClosedError } from '../accounting/fiscal-year-posting.guard';
import { lockVatDates } from '../vat/vat.router';
import { fromHalalas, groupInvoiceLines, InvoiceVatGroup, InvoiceVatTreatment, purchaseLineRecoverable, toHalalas } from '../vat/vat-invoice';
import { loadValidMappings, requiredKeys } from './invoice-account-mapping.service';
import { computeLine, formatMoney, InvoiceMathError, parseRecoverablePercent } from './invoice-math';
import { InvoiceError } from './invoice.service';

/**
 * F4 completion: REGISTRATION of externally issued credit / debit notes against an approved invoice.
 * EQFAL does not issue, number, sign or transmit any note (no e-invoicing, no ZATCA XML, no refunds). A note records what the external
 * document says; approval applies it through its OWN draft journal and never edits the original invoice, its obligation, its posted
 * journal, its VAT snapshot, its settlements or its audit trail.
 *
 * Supported (everything else is refused with a stable code, nothing is guessed):
 *   - original: an approved invoice of the same company, its journal POSTED, with a reviewed VAT snapshot;
 *   - every note line belongs to a (treatment, rate) group that EXISTS on the original invoice (no new VAT group, no rate guess);
 *   - credit notes never exceed what remains of the original group (net, VAT and, for purchases, recoverable VAT) nor the outstanding balance
 *     (so no credit balance / refund case can arise);
 *   - the note date and the original tax point date lie in the SAME, EXISTING, OPEN VAT period (otherwise the VAT period of the correction is
 *     ambiguous or a filed return would need amending: refused);
 *   - purchases keep the existing explicit recoverability rules (full / partial / non-recoverable), stated per line.
 */
/** invoice.adjust_approve alone authorizes approval; the obligation effect and the DRAFT journal are system-generated (owner decision 2026-10-15). */
export const ADJUSTMENT_APPROVAL_CAPABILITIES = ['invoice.adjust_approve'] as const;

type Direction = 'sales' | 'purchase';
type NoteType = 'credit' | 'debit';
const TREATMENTS = ['standard', 'zero_rated', 'exempt', 'out_of_scope'] as const;
const RECOVERABILITIES = ['fully_recoverable', 'non_recoverable', 'partially_recoverable'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LINES = 50;
const invalid = (message: string) => new InvoiceError(400, 'INVOICE_VALIDATION', message);
const conflict = (code: ConstructorParameters<typeof InvoiceError>[1], message: string) => new InvoiceError(409, code, message);

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x: Record<string, unknown>, keys: string[], what: string) => {
  const extra = Object.keys(x).filter((k) => !keys.includes(k));
  if (extra.length) throw invalid(`${what} has unknown fields: ${extra.join(', ')}`);
};
const dateOf = (x: unknown, field: string) => {
  if (typeof x !== 'string' || !DATE.test(x) || new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) !== x) throw invalid(`${field} must be a valid YYYY-MM-DD date`);
  return x;
};
const textOf = (x: unknown, field: string, max: number, required: boolean): string | null => {
  if (x == null || (typeof x === 'string' && !x.trim())) { if (required) throw invalid(`${field} is required`); return null; }
  if (typeof x !== 'string') throw invalid(`${field} must be text`);
  const v = x.trim();
  if (v.length > max) throw invalid(`${field} must be at most ${max} characters`);
  return v;
};

type NoteLine = {
  description: string; vat_treatment: InvoiceVatTreatment; treatment_note: string | null; vat_rate: string;
  net_amount: string; vat_amount: string; total_amount: string; vat_recoverability: string | null; vat_recoverable_percent: string | null;
};
export type AdjustmentInput = {
  adjustment_type?: NoteType; external_number: string; adjustment_date: string; reason: string; notes: string | null; source_document_id: string | null;
  lines: NoteLine[]; totals: { subtotal_amount: string; vat_amount: string; total_amount: string };
};

/** Validates a note body and computes every amount server-side from net and rate (exact integer arithmetic, line-level rounding). */
export function parseAdjustment(body: unknown, mode: 'create' | 'update'): AdjustmentInput {
  if (!isObject(body)) throw invalid('Request body must be an object');
  onlyKeys(body, ['adjustment_type', 'external_number', 'adjustment_date', 'reason', 'notes', 'source_document_id', 'lines', ...(mode === 'update' ? ['version'] : [])], 'Adjustment');
  let type: NoteType | undefined;
  if (mode === 'create') {
    if (body.adjustment_type !== 'credit' && body.adjustment_type !== 'debit') throw invalid('adjustment_type must be credit or debit');
    type = body.adjustment_type;
  } else if (body.adjustment_type !== undefined) throw invalid('adjustment_type cannot be changed');
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > MAX_LINES) throw invalid(`lines must contain 1 to ${MAX_LINES} items`);
  let subtotal = 0n, vat = 0n;
  const lines = body.lines.map((raw, i): NoteLine => {
    if (!isObject(raw)) throw invalid(`lines[${i}] must be an object`);
    onlyKeys(raw, ['description', 'vat_treatment', 'treatment_note', 'vat_rate', 'net_amount', 'vat_recoverability', 'vat_recoverable_percent'], `lines[${i}]`);
    const treatment = raw.vat_treatment;
    if (typeof treatment !== 'string' || !(TREATMENTS as readonly string[]).includes(treatment)) throw invalid(`lines[${i}].vat_treatment is required and must be a valid treatment`);
    let amounts;
    try { amounts = computeLine({ quantity: '1', unit_price: raw.net_amount, vat_rate: raw.vat_rate }); } catch (error) {
      if (error instanceof InvoiceMathError) throw invalid(`lines[${i}]: ${error.message}`);
      throw error;
    }
    if (amounts.net <= 0n) throw invalid(`lines[${i}].net_amount must be greater than zero`);
    if (treatment === 'standard' && !(Number(amounts.vat_rate) > 0)) throw invalid(`lines[${i}]: a standard line needs a VAT rate above zero`);
    if (treatment !== 'standard' && Number(amounts.vat_rate) !== 0) throw invalid(`lines[${i}]: this treatment carries no VAT, so vat_rate must be 0`);
    const recoverability = raw.vat_recoverability == null ? null : raw.vat_recoverability;
    let percent: string | null = null;
    if (recoverability !== null) {
      if (typeof recoverability !== 'string' || !(RECOVERABILITIES as readonly string[]).includes(recoverability)) throw invalid(`lines[${i}].vat_recoverability is not valid`);
      if (treatment !== 'standard') throw invalid(`lines[${i}]: vat_recoverability applies only to a standard line`);
    }
    if (recoverability === 'partially_recoverable') {
      if (raw.vat_recoverable_percent == null) throw invalid(`lines[${i}].vat_recoverable_percent is required for partially_recoverable`);
      try { percent = formatMoney(parseRecoverablePercent(raw.vat_recoverable_percent)); } catch (error) {
        if (error instanceof InvoiceMathError) throw invalid(`lines[${i}]: ${error.message}`);
        throw error;
      }
    } else if (raw.vat_recoverable_percent != null) throw invalid(`lines[${i}].vat_recoverable_percent applies only to partially_recoverable`);
    subtotal += amounts.net; vat += amounts.vat;
    return {
      description: textOf(raw.description, `lines[${i}].description`, 500, true)!, vat_treatment: treatment as InvoiceVatTreatment,
      treatment_note: textOf(raw.treatment_note, `lines[${i}].treatment_note`, 500, false), vat_rate: amounts.vat_rate,
      net_amount: amounts.net_amount, vat_amount: amounts.vat_amount, total_amount: amounts.total_amount,
      vat_recoverability: recoverability as string | null, vat_recoverable_percent: percent,
    };
  });
  const documentId = body.source_document_id == null ? null : body.source_document_id;
  if (documentId !== null && (typeof documentId !== 'string' || !UUID.test(documentId))) throw invalid('source_document_id must be a UUID');
  return {
    ...(type ? { adjustment_type: type } : {}),
    external_number: textOf(body.external_number, 'external_number', 100, true)!, adjustment_date: dateOf(body.adjustment_date, 'adjustment_date'),
    reason: textOf(body.reason, 'reason', 500, true)!, notes: textOf(body.notes, 'notes', 2000, false), source_document_id: documentId as string | null, lines,
    totals: { subtotal_amount: formatMoney(subtotal), vat_amount: formatMoney(vat), total_amount: formatMoney(subtotal + vat) },
  };
}

type Original = {
  id: string; direction: Direction; status: string; counterparty_id: string; issue_date: string; tax_point_date: string | null;
  total_amount: string; internal_number: string | null; fiscal_year_id: string | null;
};
type Header = {
  id: string; company_id: string; original_invoice_id: string; direction: Direction; adjustment_type: NoteType; status: 'draft' | 'approved' | 'cancelled';
  adjustment_date: string; external_number: string; reason: string; notes: string | null; counterparty_id: string; version: number; created_by_user_id: string;
  subtotal_amount: string; vat_amount: string; total_amount: string;
};
const HEADER_SQL = `id, company_id, original_invoice_id, direction, adjustment_type, status, adjustment_date::text, external_number, reason, notes, counterparty_id,
  version, created_by_user_id, subtotal_amount::text, vat_amount::text, total_amount::text`;

const key = (treatment: string, rate: string) => `${treatment}|${Number(rate).toFixed(2)}`;
type Bucket = { net: bigint; vat: bigint; rec: bigint };
const zero = (): Bucket => ({ net: 0n, vat: 0n, rec: 0n });

/** Recoverable VAT (halalas) of a note line from its EXPLICIT statement; sales have none. null = missing/incoherent statement. */
function lineRecoverable(direction: Direction, line: NoteLine): bigint | null {
  if (direction === 'sales') return line.vat_recoverability === null && line.vat_recoverable_percent === null ? 0n : null;
  return purchaseLineRecoverable({ vat_treatment: line.vat_treatment, vat_amount: line.vat_amount, vat_recoverability: line.vat_recoverability, vat_recoverable_percent: line.vat_recoverable_percent });
}

function noteBuckets(direction: Direction, lines: NoteLine[]): Map<string, Bucket> {
  const map = new Map<string, Bucket>();
  for (const line of lines) {
    const rec = lineRecoverable(direction, line);
    if (rec === null) throw invalid(direction === 'sales'
      ? 'Sales VAT has no recoverability'
      : 'Every standard-rated purchase note line needs an explicit, valid VAT recoverability (and a percent when partial)');
    const bucket = map.get(key(line.vat_treatment, line.vat_rate)) ?? zero();
    bucket.net += toHalalas(line.net_amount); bucket.vat += toHalalas(line.vat_amount); bucket.rec += rec;
    map.set(key(line.vat_treatment, line.vat_rate), bucket);
  }
  return map;
}

export class InvoiceAdjustmentService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      const pg = error as { code?: string; constraint?: string; message?: string };
      if (error instanceof AccountingPeriodClosedError) throw conflict('INVOICE_PERIOD_CLOSED', 'The accounting period of the note date is closed');
      if (error instanceof FiscalYearClosedError) throw conflict('INVOICE_FISCAL_YEAR_CLOSED', 'The fiscal year of the note date is closed');
      if (pg.code === '23505' && pg.constraint === 'invoice_adjustments_external_number_uidx') throw conflict('INVOICE_ADJUSTMENT_DUPLICATE', 'This external note number is already registered for this counterparty');
      if (pg.code === '23505' && pg.constraint === 'invoice_adjustment_source_links_document_id_key') throw conflict('INVOICE_SOURCE_ALREADY_LINKED', 'The document is already linked to another note');
      if (pg.code === '23514' && /already linked/i.test(pg.message ?? '')) throw conflict('INVOICE_SOURCE_ALREADY_LINKED', 'The document is already linked to an invoice or note');
      if (pg.code === '23514' && /immutable|draft/i.test(pg.message ?? '')) throw conflict('INVOICE_ADJUSTMENT_NOT_DRAFT', 'Only draft notes can be changed');
      throw error;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------- reads
  private async read(client: PoolClient, companyId: string, id: string) {
    const header = (await client.query(
      `SELECT a.id, a.original_invoice_id, a.direction, a.adjustment_type, a.status, a.adjustment_date::text, a.external_number, a.reason, a.notes, a.counterparty_id,
              c.name AS counterparty_name, a.currency, a.subtotal_amount::text, a.vat_amount::text, a.total_amount::text, a.created_by_user_id, a.approved_by_user_id,
              a.approved_at, a.cancelled_by_user_id, a.cancelled_at, a.cancellation_reason, a.fiscal_year_id, a.version, a.created_at, a.updated_at,
              i.internal_number AS original_internal_number, i.external_reference AS original_external_reference, i.total_amount::text AS original_total_amount,
              l.document_id AS source_document_id, j.id AS journal_id, j.status AS journal_status
       FROM invoice_adjustments a
       JOIN counterparties c ON c.id = a.counterparty_id AND c.company_id = a.company_id
       JOIN invoices i ON i.id = a.original_invoice_id AND i.company_id = a.company_id
       LEFT JOIN invoice_adjustment_source_links l ON l.adjustment_id = a.id AND l.company_id = a.company_id
       LEFT JOIN journal_entries j ON j.company_id = a.company_id AND j.source_type = 'invoice_adjustment' AND j.source_id = a.id
       WHERE a.id = $1 AND a.company_id = $2`, [id, companyId])).rows[0];
    if (!header) return null;
    const lines = (await client.query(
      `SELECT line_number, description, vat_treatment, treatment_note, vat_rate::text, net_amount::text, vat_amount::text, total_amount::text, vat_recoverability, vat_recoverable_percent::text
       FROM invoice_adjustment_lines WHERE adjustment_id = $1 AND company_id = $2 ORDER BY line_number`, [id, companyId])).rows;
    const { journal_id, journal_status, ...rest } = header;
    return { ...rest, journal: journal_id ? { id: journal_id, status: journal_status } : null, lines } as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  async get(companyId: string, id: string) {
    const client = await this.db.connect();
    try {
      const note = await this.read(client, companyId, id);
      if (!note) throw new InvoiceError(404, 'INVOICE_ADJUSTMENT_NOT_FOUND', 'Credit/debit note not found');
      return note;
    } finally { client.release(); }
  }

  async listForInvoice(companyId: string, invoiceId: string) {
    const exists = await this.db.query('SELECT 1 FROM invoices WHERE id = $1 AND company_id = $2', [invoiceId, companyId]);
    if (!exists.rowCount) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    const rows = (await this.db.query(
      `SELECT a.id, a.adjustment_type, a.status, a.adjustment_date::text, a.external_number, a.reason, a.subtotal_amount::text, a.vat_amount::text, a.total_amount::text,
              a.version, j.id AS journal_id, j.status AS journal_status
       FROM invoice_adjustments a LEFT JOIN journal_entries j ON j.company_id = a.company_id AND j.source_type = 'invoice_adjustment' AND j.source_id = a.id
       WHERE a.original_invoice_id = $1 AND a.company_id = $2 ORDER BY a.adjustment_date, a.created_at, a.id`, [invoiceId, companyId])).rows;
    return { adjustments: rows };
  }

  // ---------------------------------------------------------------------------------------------------------- validation
  /**
   * Every rule that depends on the original invoice and the books. Shared by draft save (early feedback) and approval (authoritative, under locks).
   * Reads only; the caller owns the locks.
   */
  private async validate(client: PoolClient, companyId: string, invoiceId: string, type: NoteType, input: AdjustmentInput, excludeId: string | null) {
    const original = (await client.query<Original>(
      `SELECT id, direction, status, counterparty_id, issue_date::text, tax_point_date::text, total_amount::text, internal_number::text, fiscal_year_id
       FROM invoices WHERE id = $1 AND company_id = $2`, [invoiceId, companyId])).rows[0];
    if (!original) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    if (original.status !== 'approved') throw conflict('INVOICE_ADJUSTMENT_ORIGINAL_UNSUPPORTED', 'A credit or debit note can only be registered against an approved invoice');
    const obligation = (await client.query<{ id: string; original_amount: string; is_cancelled: boolean; paid: string; net: string }>(
      `SELECT o.id, o.original_amount::text, o.is_cancelled,
              COALESCE((SELECT SUM(s.amount) FROM obligation_settlements s WHERE s.obligation_id = o.id AND s.company_id = o.company_id), 0)::text AS paid,
              obligation_adjustment_net(o.id, o.company_id)::text AS net
       FROM obligations o WHERE o.invoice_id = $1 AND o.company_id = $2 AND o.source_type = 'invoice'`, [invoiceId, companyId])).rows[0];
    if (!obligation || obligation.is_cancelled) throw conflict('INVOICE_ADJUSTMENT_ORIGINAL_UNSUPPORTED', 'The original invoice has no active receivable/payable');
    const journal = (await client.query<{ status: string }>(
      `SELECT status FROM journal_entries WHERE company_id = $1 AND source_type = 'obligation' AND source_id = $2 ORDER BY (status = 'posted') DESC, created_at LIMIT 1`, [companyId, obligation.id])).rows[0];
    if (journal?.status !== 'posted') throw conflict('INVOICE_ADJUSTMENT_ORIGINAL_UNSUPPORTED', 'The original invoice journal must be posted before a note can be registered');
    if (!original.tax_point_date) throw conflict('INVOICE_ADJUSTMENT_ORIGINAL_UNSUPPORTED', 'The original invoice has no tax point date');
    if (input.adjustment_date < original.issue_date) throw invalid('adjustment_date cannot be before the issue date of the original invoice');

    // Per-group caps against what EXISTS on the original VAT snapshot. No group on the original = unsupported (no new rate or treatment is invented).
    const originalGroups = new Map<string, Bucket>();
    for (const g of (await client.query<{ vat_treatment: string; vat_rate: string; taxable_amount: string; vat_amount: string; recoverable_vat_amount: string | null }>(
      `SELECT g.vat_treatment, g.vat_rate::text, g.taxable_amount::text, g.vat_amount::text, g.recoverable_vat_amount::text
       FROM invoice_vat_review_groups g JOIN invoice_vat_reviews r ON r.id = g.review_id AND r.company_id = g.company_id
       WHERE r.invoice_id = $1 AND r.company_id = $2`, [invoiceId, companyId])).rows) {
      originalGroups.set(key(g.vat_treatment, g.vat_rate), { net: toHalalas(g.taxable_amount), vat: toHalalas(g.vat_amount), rec: toHalalas(g.recoverable_vat_amount) });
    }
    if (!originalGroups.size) throw conflict('INVOICE_ADJUSTMENT_ORIGINAL_UNSUPPORTED', 'The original invoice has no reviewed VAT snapshot');
    const remaining = new Map([...originalGroups].map(([k, b]) => [k, { ...b }]));
    for (const row of (await client.query<{ adjustment_type: NoteType; vat_treatment: string; vat_rate: string; net: string; vat: string; rec: string | null }>(
      `SELECT a.adjustment_type, l.vat_treatment, l.vat_rate::text, SUM(l.net_amount)::text AS net, SUM(l.vat_amount)::text AS vat,
              SUM(line_recoverable(a.direction, l.vat_treatment, l.vat_amount, l.vat_recoverability, l.vat_recoverable_percent))::text AS rec
       FROM invoice_adjustments a JOIN invoice_adjustment_lines l ON l.adjustment_id = a.id AND l.company_id = a.company_id
       WHERE a.original_invoice_id = $1 AND a.company_id = $2 AND a.status = 'approved' AND ($3::uuid IS NULL OR a.id <> $3)
       GROUP BY a.adjustment_type, l.vat_treatment, l.vat_rate`, [invoiceId, companyId, excludeId])).rows) {
      const bucket = remaining.get(key(row.vat_treatment, row.vat_rate)) ?? zero();
      const sign = row.adjustment_type === 'debit' ? 1n : -1n;
      bucket.net += sign * toHalalas(row.net); bucket.vat += sign * toHalalas(row.vat); bucket.rec += sign * toHalalas(row.rec);
      remaining.set(key(row.vat_treatment, row.vat_rate), bucket);
    }
    const buckets = noteBuckets(original.direction, input.lines);
    for (const [k, b] of buckets) {
      const left = remaining.get(k);
      if (!originalGroups.has(k) || !left) throw conflict('INVOICE_ADJUSTMENT_GROUP_UNSUPPORTED', `The original invoice has no VAT group ${k.replace('|', ' at ')}%; a note cannot introduce a new treatment or rate`);
      if (type === 'credit' && (b.net > left.net || b.vat > left.vat || (original.direction === 'purchase' && b.rec > left.rec))) {
        throw conflict('INVOICE_ADJUSTMENT_EXCEEDS_ORIGINAL', `The credit exceeds what remains of the original invoice for VAT group ${k.replace('|', ' at ')}%`);
      }
    }
    // Over-crediting would create a credit balance (customer/supplier credit, refund): unsupported. Debit notes only increase the balance.
    const outstanding = toHalalas(obligation.original_amount) + toHalalas(obligation.net) - toHalalas(obligation.paid);
    if (type === 'credit' && toHalalas(input.totals.total_amount) > outstanding) {
      throw conflict('INVOICE_ADJUSTMENT_EXCEEDS_OUTSTANDING', `The credit (${input.totals.total_amount}) exceeds the outstanding balance (${fromHalalas(outstanding > 0n ? outstanding : 0n)}); credit balances and refunds are not supported`);
    }
    // VAT period: note date and original tax point date must share ONE existing open VAT period.
    const periods = (await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM vat_periods WHERE company_id = $1 AND $2::date BETWEEN period_start AND period_end`, [companyId, original.tax_point_date])).rows.concat(
      (await client.query<{ id: string; status: string }>(`SELECT id, status FROM vat_periods WHERE company_id = $1 AND $2::date BETWEEN period_start AND period_end`, [companyId, input.adjustment_date])).rows);
    if (periods.some((p) => p.status === 'closed')) {
      throw conflict('INVOICE_VAT_PERIOD_CLOSED', 'A VAT period involved is closed; this correction would need an amended VAT return and is not supported');
    }
    if (periods.length !== 2 || periods[0]!.id !== periods[1]!.id) {
      throw conflict('INVOICE_ADJUSTMENT_VAT_PERIOD_UNSUPPORTED', 'The note date and the original tax point date must fall in the same existing open VAT period; any other VAT-period treatment needs an owner decision');
    }
    return { original, obligation };
  }

  private async checkReferences(client: PoolClient, companyId: string, input: AdjustmentInput, selfId: string | null) {
    if (!input.source_document_id) return;
    if (!(await client.query('SELECT 1 FROM documents WHERE id = $1 AND company_id = $2', [input.source_document_id, companyId])).rowCount) {
      throw new InvoiceError(400, 'INVOICE_DOCUMENT_INVALID', 'Supporting document not found');
    }
    const linkedInvoice = await client.query('SELECT 1 FROM invoice_source_links WHERE document_id = $1 AND company_id = $2', [input.source_document_id, companyId]);
    const linkedNote = (await client.query<{ adjustment_id: string }>('SELECT adjustment_id FROM invoice_adjustment_source_links WHERE document_id = $1 AND company_id = $2', [input.source_document_id, companyId])).rows[0];
    if (linkedInvoice.rowCount || (linkedNote && linkedNote.adjustment_id !== selfId)) throw conflict('INVOICE_SOURCE_ALREADY_LINKED', 'The document is already linked to an invoice or another note');
  }

  private async writeChildren(client: PoolClient, companyId: string, id: string, actorUserId: string, input: AdjustmentInput) {
    let n = 0;
    for (const line of input.lines) {
      n += 1;
      await client.query(
        `INSERT INTO invoice_adjustment_lines (company_id, adjustment_id, line_number, description, vat_treatment, treatment_note, vat_rate, net_amount, vat_amount, total_amount, vat_recoverability, vat_recoverable_percent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [companyId, id, n, line.description, line.vat_treatment, line.treatment_note, line.vat_rate, line.net_amount, line.vat_amount, line.total_amount, line.vat_recoverability, line.vat_recoverable_percent]);
    }
    if (input.source_document_id) {
      await client.query('INSERT INTO invoice_adjustment_source_links (company_id, adjustment_id, document_id, created_by_user_id) VALUES ($1,$2,$3,$4)', [companyId, id, input.source_document_id, actorUserId]);
    }
  }

  // ------------------------------------------------------------------------------------------------------------- writes
  async create(companyId: string, actorUserId: string, invoiceId: string, input: AdjustmentInput) {
    return this.tx(async (client) => {
      const type = input.adjustment_type!;
      // Serialize registrations on the same invoice so duplicate checks and caps see each other.
      const inv = (await client.query<{ direction: Direction; counterparty_id: string }>('SELECT direction, counterparty_id FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [invoiceId, companyId])).rows[0];
      if (!inv) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      await this.validate(client, companyId, invoiceId, type, input, null);
      await assertAccountingDateWritable(companyId, input.adjustment_date, client);
      await this.checkReferences(client, companyId, input, null);
      const id = (await client.query<{ id: string }>(
        `INSERT INTO invoice_adjustments (company_id, original_invoice_id, direction, adjustment_type, status, adjustment_date, subtotal_amount, vat_amount, total_amount, reason,
           created_by_user_id, external_number, counterparty_id, notes)
         VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [companyId, invoiceId, inv.direction, type, input.adjustment_date, input.totals.subtotal_amount, input.totals.vat_amount, input.totals.total_amount, input.reason,
          actorUserId, input.external_number, inv.counterparty_id, input.notes])).rows[0]!.id;
      await this.writeChildren(client, companyId, id, actorUserId, input);
      const after = await this.read(client, companyId, id);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.adjustment.create', entity_type: 'invoice_adjustment', entity_id: id, before_data: null, after_data: after as never }, client);
      return after!;
    });
  }

  private async lockDraft(client: PoolClient, companyId: string, id: string, expectedVersion: number) {
    const current = (await client.query<Header>(`SELECT ${HEADER_SQL} FROM invoice_adjustments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId])).rows[0];
    if (!current) throw new InvoiceError(404, 'INVOICE_ADJUSTMENT_NOT_FOUND', 'Credit/debit note not found');
    if (current.status !== 'draft') throw conflict('INVOICE_ADJUSTMENT_NOT_DRAFT', 'Only draft notes can be changed');
    if (current.version !== expectedVersion) throw conflict('INVOICE_VERSION_CONFLICT', 'The note was changed by someone else; reload and try again');
    return current;
  }

  /** Full replacement of a draft note's editable fields and lines (type, direction and original invoice are immutable). */
  async update(companyId: string, actorUserId: string, id: string, expectedVersion: number, input: AdjustmentInput) {
    return this.tx(async (client) => {
      const current = await this.lockDraft(client, companyId, id, expectedVersion);
      await client.query('SELECT 1 FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [current.original_invoice_id, companyId]);
      await this.validate(client, companyId, current.original_invoice_id, current.adjustment_type, input, id);
      await assertAccountingDateWritable(companyId, input.adjustment_date, client);
      await this.checkReferences(client, companyId, input, id);
      const before = await this.read(client, companyId, id);
      await client.query('DELETE FROM invoice_adjustment_lines WHERE adjustment_id = $1 AND company_id = $2', [id, companyId]);
      await client.query('DELETE FROM invoice_adjustment_source_links WHERE adjustment_id = $1 AND company_id = $2', [id, companyId]);
      await client.query(
        `UPDATE invoice_adjustments SET adjustment_date=$3, subtotal_amount=$4, vat_amount=$5, total_amount=$6, reason=$7, external_number=$8, notes=$9, version=version+1, updated_at=NOW()
         WHERE id=$1 AND company_id=$2 AND status='draft'`,
        [id, companyId, input.adjustment_date, input.totals.subtotal_amount, input.totals.vat_amount, input.totals.total_amount, input.reason, input.external_number, input.notes]);
      await this.writeChildren(client, companyId, id, actorUserId, input);
      const after = await this.read(client, companyId, id);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.adjustment.update', entity_type: 'invoice_adjustment', entity_id: id, before_data: before as never, after_data: after as never }, client);
      return after!;
    });
  }

  /** draft -> cancelled with a mandatory reason. Approved notes are never cancelled here (their effect is already in the books). */
  async cancel(companyId: string, actorUserId: string, id: string, expectedVersion: number, reason: string) {
    return this.tx(async (client) => {
      await this.lockDraft(client, companyId, id, expectedVersion);
      const before = await this.read(client, companyId, id);
      await client.query(
        `UPDATE invoice_adjustments SET status='cancelled', cancelled_by_user_id=$3, cancelled_at=NOW(), cancellation_reason=$4, version=version+1, updated_at=NOW()
         WHERE id=$1 AND company_id=$2 AND status='draft'`, [id, companyId, actorUserId, reason]);
      const after = await this.read(client, companyId, id);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.adjustment.cancel', entity_type: 'invoice_adjustment', entity_id: id, before_data: before as never, after_data: after as never }, client);
      return after!;
    });
  }

  /**
   * draft -> approved, atomically with the note's own balanced DRAFT journal (never posted here). Holding the capabilities is enough; the registrant may approve.
   * Lock order (shared with invoice approval/posting): note -> original invoice -> fiscal year -> document -> VAT month -> accounting month -> obligation.
   */
  async approve(companyId: string, actorUserId: string, caps: readonly string[], id: string, expectedVersion: number) {
    return this.tx(async (client) => {
      const note = await this.lockDraft(client, companyId, id, expectedVersion);
      const missingCaps = ADJUSTMENT_APPROVAL_CAPABILITIES.filter((c) => !caps.includes(c));
      if (missingCaps.length) throw new InvoiceError(403, 'INVOICE_FORBIDDEN', `Approving a note requires: ${missingCaps.join(', ')}`);
      const invoice = (await client.query<{ direction: Direction }>('SELECT direction FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [note.original_invoice_id, companyId])).rows[0];
      if (!invoice) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      const lines = (await client.query<NoteLine>(
        `SELECT description, vat_treatment, treatment_note, vat_rate::text, net_amount::text, vat_amount::text, total_amount::text, vat_recoverability, vat_recoverable_percent::text
         FROM invoice_adjustment_lines WHERE adjustment_id = $1 AND company_id = $2 ORDER BY line_number`, [id, companyId])).rows;
      const input: AdjustmentInput = { external_number: note.external_number, adjustment_date: note.adjustment_date, reason: note.reason, notes: note.notes, source_document_id: null, lines,
        totals: { subtotal_amount: note.subtotal_amount, vat_amount: note.vat_amount, total_amount: note.total_amount } };

      const years = (await client.query<{ id: string }>('SELECT id FROM fiscal_years WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date', [companyId, note.adjustment_date])).rows;
      if (years.length !== 1) throw conflict('INVOICE_FISCAL_YEAR_UNRESOLVED', years.length === 0 ? 'No fiscal year covers the note date' : 'More than one fiscal year covers the note date');
      const fiscalYearId = years[0]!.id;
      await assertFiscalYearOpen(companyId, fiscalYearId, note.adjustment_date, client);
      const linked = (await client.query<{ document_id: string }>('SELECT document_id FROM invoice_adjustment_source_links WHERE adjustment_id = $1 AND company_id = $2', [id, companyId])).rows[0];
      if (linked) await client.query('SELECT 1 FROM documents WHERE id = $1 AND company_id = $2 FOR UPDATE', [linked.document_id, companyId]);
      const taxPoint = (await client.query<{ tax_point_date: string }>('SELECT tax_point_date::text FROM invoices WHERE id = $1 AND company_id = $2', [note.original_invoice_id, companyId])).rows[0]?.tax_point_date;
      await lockVatDates(companyId, [note.adjustment_date, ...(taxPoint ? [taxPoint] : [])], client);
      await assertAccountingDateWritable(companyId, note.adjustment_date, client);
      // The obligation row is the serialization point shared with settlement: caps and outstanding are read AFTER this lock.
      await client.query("SELECT 1 FROM obligations WHERE invoice_id = $1 AND company_id = $2 AND source_type = 'invoice' FOR UPDATE", [note.original_invoice_id, companyId]);
      await this.validate(client, companyId, note.original_invoice_id, note.adjustment_type, input, id);

      if (linked) {
        const recognized = await client.query(
          `SELECT 1 WHERE EXISTS (SELECT 1 FROM document_vat_reviews WHERE document_id = $1 AND company_id = $2 AND review_status = 'reviewed')
              OR EXISTS (SELECT 1 FROM obligations WHERE document_id = $1 AND company_id = $2 AND source_type = 'document' AND NOT is_cancelled)
              OR EXISTS (SELECT 1 FROM custody_document_allocations WHERE document_id = $1 AND company_id = $2)`, [linked.document_id, companyId]);
        if (recognized.rowCount) throw conflict('INVOICE_DOCUMENT_ALREADY_RECOGNIZED', 'The supporting document is already recognized on its own and cannot also support this note');
      }

      // Accounting (owner mappings; nothing is inferred). Sales: Dr receivable / Cr revenue / Cr VAT_OUTPUT. Purchase: Dr expense / Dr VAT_INPUT (recoverable part) /
      // Cr payable, where non-recoverable VAT is part of the expense. A credit note is the exact mirror image; a debit note follows the original invoice's direction.
      const direction = invoice.direction;
      const recoverableOf = lines.map((l) => lineRecoverable(direction, l) ?? 0n);
      const groups: InvoiceVatGroup[] = groupInvoiceLines(lines.map((l, i) => ({ ...l, recoverable_vat_halalas: direction === 'purchase' ? recoverableOf[i] : undefined })));
      const recoverableTotal = recoverableOf.reduce((s, r) => s + r, 0n);
      const mapped = await loadValidMappings(client, companyId);
      const needed = requiredKeys(direction, direction === 'sales' ? toHalalas(note.vat_amount) > 0n : recoverableTotal > 0n);
      const missing = needed.filter((k) => !mapped[k]);
      if (missing.length) throw conflict('INVOICE_MAPPING_MISSING', `Missing or invalid account mappings: ${missing.join(', ')}`);
      const vatGroups = groups.filter((g) => g.vat_treatment === 'standard' && toHalalas(direction === 'sales' ? g.vat_amount : g.recoverable_vat_amount) > 0n);
      const natural: Array<[string, string, string, string | null]> = direction === 'sales'
        ? [[mapped.receivable!, note.total_amount, '0', null], [mapped.sales_revenue!, '0', note.subtotal_amount, null],
          ...vatGroups.map((g) => [mapped.vat_output!, '0', g.vat_amount, 'VAT_OUTPUT'] as [string, string, string, string])]
        : [[mapped.purchase_expense!, fromHalalas(toHalalas(note.subtotal_amount) + toHalalas(note.vat_amount) - recoverableTotal), '0', null],
          ...vatGroups.map((g) => [mapped.vat_input!, g.recoverable_vat_amount!, '0', 'VAT_INPUT'] as [string, string, string, string]),
          [mapped.payable!, '0', note.total_amount, null]];
      const journalLines = note.adjustment_type === 'credit' ? natural.map(([a, d, c, m]) => [a, c, d, m] as [string, string, string, string | null]) : natural;

      await client.query(
        `UPDATE invoice_adjustments SET status='approved', approved_by_user_id=$3, approved_at=NOW(), fiscal_year_id=$4, version=version+1, updated_at=NOW()
         WHERE id=$1 AND company_id=$2 AND status='draft'`, [id, companyId, actorUserId, fiscalYearId]);
      const label = `${note.adjustment_type === 'credit' ? 'Credit' : 'Debit'} note ${note.external_number}`;
      const journal = (await client.query(
        `INSERT INTO journal_entries (company_id, fiscal_year_id, accounting_date, description, reference, source_type, source_id, entry_type, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'invoice_adjustment',$6,'standard','draft',$7) RETURNING *, accounting_date::text`,
        [companyId, fiscalYearId, note.adjustment_date, label, note.external_number, id, actorUserId])).rows[0];
      for (const [i, [account, debit, credit, memo]] of journalLines.entries()) {
        await client.query('INSERT INTO journal_lines (company_id, journal_entry_id, account_id, debit, credit, sequence, memo) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [companyId, journal.id, account, debit, credit, i + 1, memo]);
      }
      const balanced = (await client.query<{ ok: boolean }>(
        'SELECT SUM(debit) = SUM(credit) AND SUM(debit) = $3::numeric AS ok FROM journal_lines WHERE journal_entry_id = $1 AND company_id = $2', [journal.id, companyId, note.total_amount])).rows[0]!.ok;
      if (!balanced) throw new Error('Note draft journal is not balanced');

      const after = await this.read(client, companyId, id);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.adjustment.approve', entity_type: 'invoice_adjustment', entity_id: id,
        before_data: note as never, after_data: { ...after, vat_groups: groups } as never }, client);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'journal.create', entity_type: 'journal_entry', entity_id: journal.id, before_data: null,
        after_data: { ...journal, lines: journalLines.map(([account, debit, credit]) => [account, debit, credit]) } as never }, client);
      return { adjustment: after!, journal_id: journal.id as string };
    });
  }
}
