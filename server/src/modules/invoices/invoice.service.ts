import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { resolveStandardRate, sameRate } from './vat-standard-rate';
import { computeLine, computeTotals, formatMoney, InvoiceMathError, LineAmounts, parseRecoverablePercent } from './invoice-math';

/**
 * Sales and purchase invoice DRAFTS (PR-2B). Drafts have no accounting, VAT or obligation effect.
 * Out of scope here: submission, approval/numbering, posting, VAT recognition, payments, credit notes.
 * Every query is scoped by company_id; composite foreign keys (migration 062) back this up in the database.
 */

export type InvoiceErrorCode =
  | 'INVOICE_VALIDATION' | 'INVOICE_NOT_FOUND' | 'INVOICE_NOT_DRAFT' | 'INVOICE_NOT_SUBMITTED' | 'INVOICE_EMPTY' | 'INVOICE_VERSION_CONFLICT'
  | 'INVOICE_ALREADY_APPROVED' | 'INVOICE_FORBIDDEN' | 'INVOICE_MAPPING_MISSING' | 'INVOICE_VAT_PREREQUISITE' | 'INVOICE_FISCAL_YEAR_UNRESOLVED' | 'INVOICE_FISCAL_YEAR_CLOSED' | 'INVOICE_PERIOD_CLOSED'
  | 'INVOICE_VAT_INCOMPLETE' | 'INVOICE_VAT_PERIOD_CLOSED' | 'INVOICE_DOCUMENT_ALREADY_RECOGNIZED' | 'INVOICE_DIRECTION_UNSUPPORTED'
  | 'INVOICE_DUPLICATE_REFERENCE' | 'INVOICE_SOURCE_ALREADY_LINKED' | 'INVOICE_COUNTERPARTY_INVALID' | 'INVOICE_DOCUMENT_INVALID'
  | 'INVOICE_VAT_RATE_MISMATCH' | 'VAT_RATE_NOT_CONFIGURED'
  | 'INVOICE_ALREADY_CANCELLED' | 'INVOICE_CANCEL_NOT_ALLOWED' | 'INVOICE_DELETE_NOT_ALLOWED'
  | 'INVOICE_ADJUSTMENT_NOT_FOUND' | 'INVOICE_ADJUSTMENT_NOT_DRAFT' | 'INVOICE_ADJUSTMENT_ORIGINAL_UNSUPPORTED' | 'INVOICE_ADJUSTMENT_GROUP_UNSUPPORTED'
  | 'INVOICE_ADJUSTMENT_EXCEEDS_ORIGINAL' | 'INVOICE_ADJUSTMENT_EXCEEDS_OUTSTANDING' | 'INVOICE_ADJUSTMENT_VAT_PERIOD_UNSUPPORTED' | 'INVOICE_ADJUSTMENT_DUPLICATE'
  | 'INVOICE_ADJUSTMENT_NOT_APPROVED' | 'INVOICE_ADJUSTMENT_JOURNAL_NOT_DRAFT' | 'INVOICE_ADJUSTMENT_VOID_BLOCKED' | 'INVOICE_CONCURRENT_MODIFICATION'
  | 'RECURRING_NOT_FOUND' | 'RECURRING_VERSION_CONFLICT' | 'RECURRING_INVALID_STATE' | 'RECURRING_SCHEDULE_LOCKED';

export class InvoiceError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: InvoiceErrorCode, message: string, readonly details?: Record<string, unknown>) { super(message); }
}

const invalid = (message: string) => new InvoiceError(400, 'INVOICE_VALIDATION', message);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINES = 200;
const DIRECTIONS = ['sales', 'purchase'] as const;
const STATUSES = ['draft', 'submitted', 'approved', 'cancelled'] as const;
type Direction = (typeof DIRECTIONS)[number];
const TREATMENTS = ['standard', 'zero_rated', 'exempt', 'out_of_scope'] as const;
export type VatTreatment = (typeof TREATMENTS)[number];
// V2.1 purchases (owner policy 2026-10-12): the creator states the input VAT recovery explicitly; it is never inferred.
// Partial recovery also states an explicit percent (strictly between 0 and 100). Expense purchases only; asset purchases are unsupported.
const RECOVERABILITIES = ['fully_recoverable', 'non_recoverable', 'partially_recoverable'] as const;
export type VatRecoverability = (typeof RECOVERABILITIES)[number];

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const onlyKeys = (x: Record<string, unknown>, keys: string[], what: string) => {
  const extra = Object.keys(x).filter((k) => !keys.includes(k));
  if (extra.length) throw invalid(`${what} has unknown fields: ${extra.join(', ')}`);
};
const uuid = (x: unknown, field: string) => { if (typeof x !== 'string' || !UUID.test(x)) throw invalid(`${field} must be a UUID`); return x; };
const optionalUuid = (x: unknown, field: string) => (x == null ? null : uuid(x, field));
const date = (x: unknown, field: string) => {
  if (typeof x !== 'string' || !DATE.test(x)) throw invalid(`${field} must be YYYY-MM-DD`);
  const d = new Date(`${x}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== x) throw invalid(`${field} is not a valid date`);
  return x;
};
const optionalDate = (x: unknown, field: string) => (x == null ? null : date(x, field));
const text = (x: unknown, field: string, max: number, required = false): string | null => {
  if (x == null) { if (required) throw invalid(`${field} is required`); return null; }
  if (typeof x !== 'string') throw invalid(`${field} must be text`);
  const v = x.trim();
  if (!v) { if (required) throw invalid(`${field} is required`); return null; }
  if (v.length > max) throw invalid(`${field} must be at most ${max} characters`);
  return v;
};

export type DraftInput = {
  counterparty_id: string; issue_date: string; due_date: string | null; supply_date: string | null; tax_point_date: string | null;
  external_reference: string | null; notes: string | null; source_document_id: string | null;
  lines: Array<LineAmounts & { description: string; vat_treatment: VatTreatment | null; treatment_note: string | null; vat_recoverability: VatRecoverability | null; vat_recoverable_percent: string | null }>;
  totals: { subtotal_amount: string; vat_amount: string; total_amount: string };
};

const DRAFT_FIELDS = ['counterparty_id', 'issue_date', 'due_date', 'supply_date', 'external_reference', 'notes', 'source_document_id', 'lines', 'tax_point_date'];

/** Sales VAT is output VAT and has no recoverability; only purchase lines may carry one. */
/**
 * Sales only (ordinary standard-rated supplies). Every standard line must carry the effective standard rate for the
 * tax point date. No configured rate fails closed; a stored rate is never rewritten. Other treatments are untouched.
 */
async function assertStandardRates(client: PoolClient, direction: Direction, taxPointDate: string | null, lines: ReadonlyArray<{ vat_treatment: string | null; vat_rate: string }>) {
  if (direction !== 'sales' || !taxPointDate) return;
  const standard = lines.filter((l) => l.vat_treatment === 'standard');
  if (standard.length === 0) return;
  const resolved = await resolveStandardRate(client, taxPointDate);
  if (!resolved) throw new InvoiceError(409, 'VAT_RATE_NOT_CONFIGURED', `No standard VAT rate is configured for ${taxPointDate}; standard-rated lines cannot be saved or submitted`);
  if (standard.some((l) => !sameRate(l.vat_rate, resolved.rate))) {
    throw new InvoiceError(409, 'INVOICE_VAT_RATE_MISMATCH', `Standard-rated lines must use the VAT rate ${resolved.rate}% effective on ${taxPointDate}`);
  }
}

function assertRecoverabilityDirection(direction: Direction, input: DraftInput) {
  if (direction === 'sales' && input.lines.some((l) => l.vat_recoverability !== null || l.vat_recoverable_percent !== null)) {
    throw new InvoiceError(400, 'INVOICE_VALIDATION', 'vat_recoverability and vat_recoverable_percent apply only to purchase invoice lines');
  }
}

/** Validates a full draft body (create or full replacement on edit) and computes all amounts server-side. */
export function parseDraft(body: unknown, extraKeys: string[] = []): DraftInput {
  if (!isObject(body)) throw invalid('Request body must be an object');
  onlyKeys(body, [...DRAFT_FIELDS, ...extraKeys], 'Invoice');
  const issue = date(body.issue_date, 'issue_date');
  const due = optionalDate(body.due_date, 'due_date');
  if (due && due < issue) throw invalid('due_date must not be before issue_date');
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > MAX_LINES) throw invalid(`lines must contain 1 to ${MAX_LINES} items`);
  const lines = body.lines.map((raw, i) => {
    if (!isObject(raw)) throw invalid(`lines[${i}] must be an object`);
    onlyKeys(raw, ['description', 'quantity', 'unit_price', 'discount_amount', 'vat_rate', 'vat_treatment', 'treatment_note', 'vat_recoverability', 'vat_recoverable_percent'], `lines[${i}]`);
    try {
      const amounts = computeLine(raw as never);
      // The treatment is chosen explicitly by the creator and is never derived from the rate. Only coherence is checked here.
      const treatment = raw.vat_treatment == null ? null : raw.vat_treatment;
      if (treatment !== null && !TREATMENTS.includes(treatment as VatTreatment)) throw invalid(`lines[${i}].vat_treatment is not valid`);
      if (treatment === 'standard' && !(Number(amounts.vat_rate) > 0)) throw invalid(`lines[${i}]: a standard line needs a VAT rate above zero`);
      if (treatment !== null && treatment !== 'standard' && Number(amounts.vat_rate) !== 0) throw invalid(`lines[${i}]: this treatment carries no VAT, so vat_rate must be 0`);
      // Input VAT recovery is stated explicitly (purchases only; checked against the direction by the service), never inferred.
      const recoverability = raw.vat_recoverability == null ? null : raw.vat_recoverability;
      let percent: string | null = null;
      if (recoverability !== null) {
        if (!RECOVERABILITIES.includes(recoverability as VatRecoverability)) throw invalid(`lines[${i}].vat_recoverability is not valid`);
        if (treatment !== 'standard') throw invalid(`lines[${i}]: vat_recoverability applies only to a standard line`);
      }
      if (recoverability === 'partially_recoverable') {
        // The percent is explicit input: missing, malformed, <= 0 or >= 100 is rejected, never defaulted. Stored with 2 decimals.
        if (raw.vat_recoverable_percent == null) throw invalid(`lines[${i}].vat_recoverable_percent is required for partially_recoverable`);
        percent = formatMoney(parseRecoverablePercent(raw.vat_recoverable_percent));
      } else if (raw.vat_recoverable_percent != null) {
        throw invalid(`lines[${i}].vat_recoverable_percent applies only to partially_recoverable`);
      }
      return {
        description: text(raw.description, `lines[${i}].description`, 500, true)!, ...amounts,
        vat_treatment: treatment as VatTreatment | null, treatment_note: text(raw.treatment_note, `lines[${i}].treatment_note`, 500),
        vat_recoverability: recoverability as VatRecoverability | null, vat_recoverable_percent: percent,
      };
    } catch (error) {
      if (error instanceof InvoiceMathError) throw invalid(`lines[${i}]: ${error.message}`);
      throw error;
    }
  });
  let totals;
  try { totals = computeTotals(lines); } catch (error) { if (error instanceof InvoiceMathError) throw invalid(error.message); throw error; }
  return {
    counterparty_id: uuid(body.counterparty_id, 'counterparty_id'),
    issue_date: issue, due_date: due, supply_date: optionalDate(body.supply_date, 'supply_date'), tax_point_date: optionalDate(body.tax_point_date, 'tax_point_date'),
    external_reference: text(body.external_reference, 'external_reference', 100),
    notes: text(body.notes, 'notes', 2000),
    source_document_id: optionalUuid(body.source_document_id, 'source_document_id'),
    lines, totals,
  };
}

export type ListFilters = {
  direction: Direction | null; status: string | null; counterparty_id: string | null;
  from: string | null; to: string | null; q: string | null; limit: number; offset: number;
};

export function parseListQuery(query: Record<string, unknown>): ListFilters {
  onlyKeys(query, ['direction', 'status', 'counterparty_id', 'from', 'to', 'q', 'limit', 'offset'], 'Query');
  const one = (x: unknown) => (Array.isArray(x) ? (() => { throw invalid('Repeated query parameters are not allowed'); })() : x);
  const direction = one(query.direction), status = one(query.status);
  if (direction != null && !DIRECTIONS.includes(direction as Direction)) throw invalid('direction must be sales or purchase');
  if (status != null && !STATUSES.includes(status as never)) throw invalid('status is not valid');
  const int = (x: unknown, field: string, fallback: number, min: number, max: number) => {
    if (x == null) return fallback;
    if (typeof x !== 'string' || !/^\d{1,6}$/.test(x) || Number(x) < min || Number(x) > max) throw invalid(`${field} must be an integer from ${min} to ${max}`);
    return Number(x);
  };
  const from = optionalDate(one(query.from), 'from'), to = optionalDate(one(query.to), 'to');
  if (from && to && to < from) throw invalid('to must not be before from');
  const rawQ = one(query.q);
  if (rawQ != null && typeof rawQ !== 'string') throw invalid('q must be text');
  const q = rawQ == null ? null : rawQ.trim() || null;
  if (q && q.length > 100) throw invalid('q must be at most 100 characters');
  return {
    direction: (direction as Direction) ?? null, status: (status as string) ?? null,
    counterparty_id: optionalUuid(one(query.counterparty_id), 'counterparty_id'), from, to, q,
    limit: int(one(query.limit), 'limit', 50, 1, 100), offset: int(one(query.offset), 'offset', 0, 0, 100000),
  };
}

const HEADER_COLUMNS = `i.id, i.company_id, i.direction, i.status, i.counterparty_id, c.name AS counterparty_name, i.fiscal_year_id,
  i.internal_number, i.external_reference, i.issue_date::text, i.due_date::text, i.supply_date::text, i.tax_point_date::text, i.currency,
  i.subtotal_amount::text, i.vat_amount::text, i.total_amount::text, i.notes, i.origin, i.created_by_user_id,
  i.approved_by_user_id, i.approved_at, i.cancelled_by_user_id, i.cancelled_at, i.cancellation_reason, i.version, i.created_at, i.updated_at`;

/** Authoritative approval-side records, joined read-only. Absent (null) until the invoice is approved. */
const LINKED_JOINS = `
  LEFT JOIN obligations ob ON ob.invoice_id = i.id AND ob.company_id = i.company_id AND ob.source_type = 'invoice'
  LEFT JOIN LATERAL (SELECT je.id, je.status FROM journal_entries je WHERE je.company_id = i.company_id AND je.source_type = 'obligation'
                     AND je.source_id = ob.id ORDER BY je.created_at, je.id LIMIT 1) jr ON TRUE
  LEFT JOIN LATERAL (SELECT v.id, v.tax_date::text AS tax_date FROM invoice_vat_reviews v WHERE v.invoice_id = i.id AND v.company_id = i.company_id LIMIT 1) vr ON TRUE
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(s.amount), 0) AS paid FROM obligation_settlements s WHERE s.obligation_id = ob.id AND s.company_id = i.company_id) st ON TRUE`;
const LINKED_COLUMNS = `ob.id AS obligation_id, ob.is_cancelled AS obligation_cancelled, ob.original_amount::text AS obligation_amount,
  jr.id AS journal_id, jr.status AS journal_status, vr.id AS vat_review_id, vr.tax_date AS vat_review_tax_date,
  st.paid::numeric(18,2)::text AS paid_raw, (ob.original_amount + obligation_adjustment_net(ob.id, ob.company_id) - st.paid)::numeric(18,2)::text AS outstanding_raw,
  obligation_adjustment_net(ob.id, ob.company_id)::numeric(18,2)::text AS adjustments_net_raw,
  (ob.original_amount + obligation_adjustment_net(ob.id, ob.company_id))::numeric(18,2)::text AS adjusted_raw`;

export type InvoiceActionableStatus = 'draft' | 'awaiting_approval' | 'awaiting_posting' | 'awaiting_settlement' | 'partially_settled' | 'settled' | 'cancelled';

/** Derives the extra read-model fields from the joined records. Never inferred from the status alone once the records exist. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withLinked(row: any) {
  const { cancelled_by_user_id, cancelled_at, cancellation_reason, obligation_id, obligation_cancelled, obligation_amount, journal_id, journal_status, vat_review_id, vat_review_tax_date, paid_raw, outstanding_raw, adjustments_net_raw, adjusted_raw, ...rest } = row as Record<string, unknown>;
  const status = rest.status as string;
  const hasObligation = obligation_id != null;
  const paid = hasObligation ? (paid_raw as string) : null;
  const outstanding = hasObligation ? (outstanding_raw as string) : null;
  let actionable: InvoiceActionableStatus;
  if (status === 'cancelled' || obligation_cancelled === true) actionable = 'cancelled';
  else if (status === 'draft') actionable = 'draft';
  else if (status === 'submitted') actionable = 'awaiting_approval';
  else if (journal_status !== 'posted') actionable = 'awaiting_posting';
  else if (outstanding !== null && Number(outstanding) <= 0) actionable = 'settled';
  else if (paid !== null && Number(paid) > 0) actionable = 'partially_settled';
  else actionable = 'awaiting_settlement';
  return {
    ...rest,
    obligation: hasObligation ? { id: obligation_id, is_cancelled: obligation_cancelled, original_amount: obligation_amount } : null,
    journal: journal_id != null ? { id: journal_id, status: journal_status } : null,
    vat: { status: vat_review_id != null ? 'reviewed' : status === 'approved' ? 'missing' : 'pending', review_id: vat_review_id ?? null, tax_date: vat_review_tax_date ?? null },
    cancellation: status === 'cancelled' ? { cancelled_by_user_id, cancelled_at, reason: cancellation_reason } : null,
    paid_amount: paid, outstanding_amount: outstanding, actionable_status: actionable,
    // Approved credit/debit notes adjust the SAME obligation (never a second receivable/payable): adjusted = original +debit -credit.
    adjustments_net_amount: hasObligation ? (adjustments_net_raw as string) : null, adjusted_amount: hasObligation ? (adjusted_raw as string) : null,
  } as Record<string, any> & {
    obligation: { id: string; is_cancelled: boolean; original_amount: string } | null; journal: { id: string; status: string } | null;
    vat: { status: 'pending' | 'reviewed' | 'missing'; review_id: string | null; tax_date: string | null };
    paid_amount: string | null; outstanding_amount: string | null; actionable_status: InvoiceActionableStatus;
    cancellation: { cancelled_by_user_id: string; cancelled_at: string; reason: string } | null;
  };
}

export class InvoiceDraftService {
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
      const pg = error as { code?: string; constraint?: string };
      if (pg.code === '23505' && pg.constraint === 'invoices_purchase_supplier_reference_uidx') {
        throw new InvoiceError(409, 'INVOICE_DUPLICATE_REFERENCE', 'This supplier reference is already used for this supplier');
      }
      if (pg.code === '23505' && pg.constraint === 'invoice_source_links_document_id_key') {
        throw new InvoiceError(409, 'INVOICE_SOURCE_ALREADY_LINKED', 'The document is already linked to another invoice');
      }
      // The header/line guards (migration 062) reject any change once an invoice has left draft.
      if (pg.code === '23514' && /immutable|cannot be altered|draft/i.test((error as Error).message)) {
        throw new InvoiceError(409, 'INVOICE_NOT_DRAFT', 'Only draft invoices can be edited');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Counterparty and evidence document must belong to the active company; a cross-company id reads as not found. */
  private async checkReferences(client: PoolClient, companyId: string, direction: Direction, input: DraftInput, invoiceId: string | null) {
    const cp = (await client.query<{ type: string; is_active: boolean }>(
      'SELECT type, is_active FROM counterparties WHERE id = $1 AND company_id = $2', [input.counterparty_id, companyId])).rows[0];
    if (!cp || !cp.is_active) throw new InvoiceError(400, 'INVOICE_COUNTERPARTY_INVALID', 'Counterparty not found or inactive');
    // counterparties.type CHECK (migration 017): customer | supplier | government | other.
    // A sales invoice cannot be issued to a supplier, nor a purchase recorded from a customer.
    // ASSUMPTION (documented, not an accounting policy): government and other are accepted in both directions
    // for drafts. Approval (a later PR) may tighten this once the owner decides.
    if ((direction === 'sales' && cp.type === 'supplier') || (direction === 'purchase' && cp.type === 'customer')) {
      throw new InvoiceError(400, 'INVOICE_COUNTERPARTY_INVALID', `Counterparty type ${cp.type} cannot be used on a ${direction} invoice`);
    }
    if (input.source_document_id) {
      const doc = await client.query('SELECT 1 FROM documents WHERE id = $1 AND company_id = $2', [input.source_document_id, companyId]);
      if (!doc.rowCount) throw new InvoiceError(400, 'INVOICE_DOCUMENT_INVALID', 'Source document not found');
      const linked = await client.query<{ invoice_id: string }>(
        'SELECT invoice_id FROM invoice_source_links WHERE document_id = $1 AND company_id = $2', [input.source_document_id, companyId]);
      if (linked.rows[0] && linked.rows[0].invoice_id !== invoiceId) {
        throw new InvoiceError(409, 'INVOICE_SOURCE_ALREADY_LINKED', 'The document is already linked to another invoice');
      }
    }
  }

  private async writeChildren(client: PoolClient, companyId: string, invoiceId: string, actorUserId: string, input: DraftInput) {
    let n = 0;
    for (const line of input.lines) {
      n += 1;
      await client.query(
        `INSERT INTO invoice_lines (company_id, invoice_id, line_number, description, quantity, unit_price, discount_amount, vat_rate, net_amount, vat_amount, total_amount, vat_treatment, treatment_note, vat_recoverability, vat_recoverable_percent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [companyId, invoiceId, n, line.description, line.quantity, line.unit_price, line.discount_amount, line.vat_rate, line.net_amount, line.vat_amount, line.total_amount, line.vat_treatment, line.treatment_note, line.vat_recoverability, line.vat_recoverable_percent],
      );
    }
    if (input.source_document_id) {
      await client.query(
        'INSERT INTO invoice_source_links (company_id, invoice_id, document_id, created_by_user_id) VALUES ($1,$2,$3,$4)',
        [companyId, invoiceId, input.source_document_id, actorUserId],
      );
    }
  }

  async create(companyId: string, actorUserId: string, direction: Direction, input: DraftInput) {
    return this.tx((client) => this.createWithin(client, companyId, actorUserId, direction, input, null));
  }

  /**
   * Draft creation inside the caller's transaction (used by recurring generation so the draft and its schedule advance commit together).
   * `recurrence` stamps origin 'recurring'; the unique index invoices_recurrence_occurrence_uidx (062) makes a second draft for the same occurrence impossible.
   */
  async createWithin(client: PoolClient, companyId: string, actorUserId: string, direction: Direction, input: DraftInput, recurrence: { templateId: string; occurrenceDate: string } | null) {
    {
      assertRecoverabilityDirection(direction, input);
      await assertStandardRates(client, direction, input.tax_point_date, input.lines);
      await this.checkReferences(client, companyId, direction, input, null);
      const id = (await client.query<{ id: string }>(
        `INSERT INTO invoices (company_id, direction, status, counterparty_id, external_reference, issue_date, due_date, supply_date,
           subtotal_amount, vat_amount, total_amount, notes, created_by_user_id, tax_point_date, origin, recurring_template_id, recurrence_occurrence_date)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [companyId, direction, input.counterparty_id, input.external_reference, input.issue_date, input.due_date, input.supply_date,
          input.totals.subtotal_amount, input.totals.vat_amount, input.totals.total_amount, input.notes, actorUserId, input.tax_point_date,
          recurrence ? 'recurring' : 'manual', recurrence?.templateId ?? null, recurrence?.occurrenceDate ?? null],
      )).rows[0]!.id;
      await this.writeChildren(client, companyId, id, actorUserId, input);
      const after = await this.read(client, companyId, id);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.draft.create', entity_type: 'invoice', entity_id: id, before_data: null, after_data: after as never }, client);
      return after!;
    }
  }

  /** Full replacement of a draft's editable fields and lines, guarded by optimistic version. Direction is immutable. */
  async update(companyId: string, actorUserId: string, invoiceId: string, expectedVersion: number, input: DraftInput) {
    return this.tx(async (client) => {
      const current = (await client.query<{ status: string; version: number; direction: Direction }>(
        'SELECT status, version, direction FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [invoiceId, companyId])).rows[0];
      if (!current) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      if (current.status !== 'draft') throw new InvoiceError(409, 'INVOICE_NOT_DRAFT', 'Only draft invoices can be edited');
      if (current.version !== expectedVersion) throw new InvoiceError(409, 'INVOICE_VERSION_CONFLICT', 'The invoice was changed by someone else; reload and try again');
      assertRecoverabilityDirection(current.direction, input);
      await assertStandardRates(client, current.direction, input.tax_point_date, input.lines);
      await this.checkReferences(client, companyId, current.direction, input, invoiceId);
      const before = await this.read(client, companyId, invoiceId);
      await client.query('DELETE FROM invoice_lines WHERE invoice_id = $1 AND company_id = $2', [invoiceId, companyId]);
      await client.query('DELETE FROM invoice_source_links WHERE invoice_id = $1 AND company_id = $2', [invoiceId, companyId]);
      await client.query(
        `UPDATE invoices SET counterparty_id=$3, external_reference=$4, issue_date=$5, due_date=$6, supply_date=$7,
           subtotal_amount=$8, vat_amount=$9, total_amount=$10, notes=$11, tax_point_date=$12, version = version + 1, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND status = 'draft'`,
        [invoiceId, companyId, input.counterparty_id, input.external_reference, input.issue_date, input.due_date, input.supply_date,
          input.totals.subtotal_amount, input.totals.vat_amount, input.totals.total_amount, input.notes, input.tax_point_date],
      );
      await this.writeChildren(client, companyId, invoiceId, actorUserId, input);
      const after = await this.read(client, companyId, invoiceId);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.draft.update', entity_type: 'invoice', entity_id: invoiceId, before_data: before as never, after_data: after as never }, client);
      return after!;
    });
  }

  /** draft -> submitted. Freezes the draft for review; no numbering, obligation, journal or VAT effect. */
  async submit(companyId: string, actorUserId: string, invoiceId: string, expectedVersion: number) {
    return this.tx(async (client) => {
      const current = await this.lockForTransition(client, companyId, invoiceId, 'draft', 'INVOICE_NOT_DRAFT', 'Only draft invoices can be submitted', expectedVersion);
      const before = await this.read(client, companyId, invoiceId);
      if (!before || before.lines.length === 0) throw new InvoiceError(409, 'INVOICE_EMPTY', 'An invoice without lines cannot be submitted');
      const cp = (await client.query<{ type: string; is_active: boolean }>(
        'SELECT type, is_active FROM counterparties WHERE id = $1 AND company_id = $2', [before.counterparty_id, companyId])).rows[0];
      if (!cp || !cp.is_active) throw new InvoiceError(400, 'INVOICE_COUNTERPARTY_INVALID', 'Counterparty not found or inactive');
      if ((current.direction === 'sales' && cp.type === 'supplier') || (current.direction === 'purchase' && cp.type === 'customer')) {
        throw new InvoiceError(400, 'INVOICE_COUNTERPARTY_INVALID', `Counterparty type ${cp.type} cannot be used on a ${current.direction} invoice`);
      }
      // V1 sales: the creator must state the tax point and a VAT treatment for every line before review. Nothing is inferred.
      // V2 purchases follow the same rule, and every standard-rated purchase line also needs an explicit input VAT recoverability.
      if (!before.tax_point_date) throw new InvoiceError(409, 'INVOICE_VAT_INCOMPLETE', `A ${current.direction} invoice needs a tax point date before it can be submitted`, { reason: 'tax_point_missing' });
      await assertStandardRates(client, current.direction, before.tax_point_date, before.lines);
      if (before.lines.some((l: { vat_treatment: string | null }) => !l.vat_treatment)) throw new InvoiceError(409, 'INVOICE_VAT_INCOMPLETE', 'Every line needs an explicit VAT treatment before the invoice can be submitted', { reason: 'line_treatment_missing' });
      if (current.direction === 'purchase' && before.lines.some((l: { vat_treatment: string | null; vat_recoverability: string | null }) => l.vat_treatment === 'standard' && !l.vat_recoverability)) {
        throw new InvoiceError(409, 'INVOICE_VAT_INCOMPLETE', 'Every standard-rated purchase line needs an explicit VAT recoverability before the invoice can be submitted', { reason: 'recoverability_missing' });
      }
      await client.query(
        `UPDATE invoices SET status = 'submitted', version = version + 1, updated_at = NOW() WHERE id = $1 AND company_id = $2 AND status = 'draft'`,
        [invoiceId, companyId]);
      const after = await this.read(client, companyId, invoiceId);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.submit', entity_type: 'invoice', entity_id: invoiceId, before_data: before as never, after_data: after as never }, client);
      return after!;
    });
  }

  /** submitted -> draft (return for correction). */
  async returnToDraft(companyId: string, actorUserId: string, invoiceId: string, expectedVersion: number) {
    return this.tx(async (client) => {
      await this.lockForTransition(client, companyId, invoiceId, 'submitted', 'INVOICE_NOT_SUBMITTED', 'Only submitted invoices can be returned to draft', expectedVersion);
      const before = await this.read(client, companyId, invoiceId);
      await client.query(
        `UPDATE invoices SET status = 'draft', version = version + 1, updated_at = NOW() WHERE id = $1 AND company_id = $2 AND status = 'submitted'`,
        [invoiceId, companyId]);
      const after = await this.read(client, companyId, invoiceId);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.return', entity_type: 'invoice', entity_id: invoiceId, before_data: before as never, after_data: after as never }, client);
      return after!;
    });
  }

  /**
   * F4: draft | submitted -> cancelled, with a mandatory reason. Only invoices WITHOUT any accounting footprint can be cancelled:
   * numbering, the obligation, the draft journal and the VAT snapshot are all created at approval, so a draft or submitted invoice has none.
   * Approved (and therefore posted) invoices are never cancelled here; their correction is a linked credit/debit note, which is blocked
   * pending owner policy decisions (see docs/INVOICE_CORRECTIONS_F4.md). Nothing is deleted: the row, its lines and the audit trail remain.
   */
  async cancel(companyId: string, actorUserId: string, invoiceId: string, expectedVersion: number, reason: string) {
    return this.tx(async (client) => {
      const current = (await client.query<{ status: string; version: number }>(
        'SELECT status, version FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [invoiceId, companyId])).rows[0];
      if (!current) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      if (current.status === 'cancelled') throw new InvoiceError(409, 'INVOICE_ALREADY_CANCELLED', 'Invoice is already cancelled');
      if (current.status === 'approved') throw new InvoiceError(409, 'INVOICE_CANCEL_NOT_ALLOWED', 'An approved invoice cannot be cancelled; correct it with a linked credit or debit note');
      if (current.version !== expectedVersion) throw new InvoiceError(409, 'INVOICE_VERSION_CONFLICT', 'The invoice was changed by someone else; reload and try again');
      // Defence in depth: any accounting record already tied to the invoice blocks cancellation, whatever the status says.
      const footprint = await client.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM obligations WHERE invoice_id = $1 AND company_id = $2)
                     OR EXISTS (SELECT 1 FROM invoice_vat_reviews WHERE invoice_id = $1 AND company_id = $2)`, [invoiceId, companyId]);
      if (footprint.rowCount) throw new InvoiceError(409, 'INVOICE_CANCEL_NOT_ALLOWED', 'The invoice already has accounting records and cannot be cancelled');
      const before = await this.read(client, companyId, invoiceId);
      await client.query(
        `UPDATE invoices SET status = 'cancelled', cancelled_by_user_id = $3, cancelled_at = NOW(), cancellation_reason = $4,
                version = version + 1, updated_at = NOW() WHERE id = $1 AND company_id = $2 AND status IN ('draft','submitted')`,
        [invoiceId, companyId, actorUserId, reason]);
      const after = await this.read(client, companyId, invoiceId);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.cancel', entity_type: 'invoice', entity_id: invoiceId, before_data: before as never, after_data: after as never }, client);
      return after!;
    });
  }

  /**
   * Phase 1 delete: physically removes a DRAFT invoice (header, lines and its evidence link). Only a draft has no accounting footprint:
   * numbering, obligation, journal and VAT snapshot are created at approval. Submitted, approved and cancelled invoices are refused
   * (cancelled keeps its row and reason as history). The uploaded evidence document itself is never touched, only its link is released.
   * The audit row keeps the full pre-delete snapshot. The database guard (migration 062) independently refuses deleting a non-draft.
   */
  async deleteDraft(companyId: string, actorUserId: string, invoiceId: string, expectedVersion: number) {
    return this.tx(async (client) => {
      const current = (await client.query<{ status: string; version: number }>(
        'SELECT status, version FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [invoiceId, companyId])).rows[0];
      if (!current) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      if (current.status !== 'draft') throw new InvoiceError(409, 'INVOICE_DELETE_NOT_ALLOWED', 'Only a draft invoice can be deleted; submitted, approved and cancelled invoices are kept on record');
      if (current.version !== expectedVersion) throw new InvoiceError(409, 'INVOICE_VERSION_CONFLICT', 'The invoice was changed by someone else; reload and try again');
      // Defence in depth: any financial record tied to the invoice blocks deletion, whatever the status says.
      const footprint = await client.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM obligations WHERE invoice_id = $1 AND company_id = $2)
                     OR EXISTS (SELECT 1 FROM invoice_vat_reviews WHERE invoice_id = $1 AND company_id = $2)
                     OR EXISTS (SELECT 1 FROM invoice_adjustments WHERE original_invoice_id = $1 AND company_id = $2)`, [invoiceId, companyId]);
      if (footprint.rowCount) throw new InvoiceError(409, 'INVOICE_DELETE_NOT_ALLOWED', 'The invoice already has financial records and cannot be deleted');
      const before = await this.read(client, companyId, invoiceId);
      await client.query('DELETE FROM invoices WHERE id = $1 AND company_id = $2 AND status = \'draft\'', [invoiceId, companyId]);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.draft.delete', entity_type: 'invoice', entity_id: invoiceId, before_data: before as never, after_data: null }, client);
    });
  }

  private async lockForTransition(client: PoolClient, companyId: string, invoiceId: string, from: string,
    wrongState: 'INVOICE_NOT_DRAFT' | 'INVOICE_NOT_SUBMITTED', wrongStateMessage: string, expectedVersion: number) {
    const current = (await client.query<{ status: string; version: number; direction: Direction }>(
      'SELECT status, version, direction FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [invoiceId, companyId])).rows[0];
    if (!current) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    if (current.status !== from) throw new InvoiceError(409, wrongState, wrongStateMessage);
    if (current.version !== expectedVersion) throw new InvoiceError(409, 'INVOICE_VERSION_CONFLICT', 'The invoice was changed by someone else; reload and try again');
    return current;
  }

  async get(companyId: string, invoiceId: string) {
    const client = await this.db.connect();
    try {
      const invoice = await this.read(client, companyId, invoiceId);
      if (!invoice) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      return invoice;
    } finally {
      client.release();
    }
  }

  private async read(client: PoolClient, companyId: string, invoiceId: string) {
    const header = (await client.query(
      `SELECT ${HEADER_COLUMNS}, l.document_id AS source_document_id, ${LINKED_COLUMNS}
       FROM invoices i
       JOIN counterparties c ON c.id = i.counterparty_id AND c.company_id = i.company_id
       LEFT JOIN invoice_source_links l ON l.invoice_id = i.id AND l.company_id = i.company_id${LINKED_JOINS}
       WHERE i.id = $1 AND i.company_id = $2`, [invoiceId, companyId])).rows[0];
    if (!header) return null;
    const lines = (await client.query(
      `SELECT line_number, description, quantity::text, unit_price::text, discount_amount::text, vat_rate::text,
              net_amount::text, vat_amount::text, total_amount::text, vat_treatment, treatment_note, vat_recoverability, vat_recoverable_percent::text
       FROM invoice_lines WHERE invoice_id = $1 AND company_id = $2 ORDER BY line_number`, [invoiceId, companyId])).rows;
    // Read-only settlement history of the linked obligation (the one settlement mechanism). Absent obligation => no history.
    const settlements = header.obligation_id == null ? [] : (await client.query(
      `SELECT s.id, s.bank_transaction_id, s.amount::text, s.note, t.transaction_date::text, t.description
       FROM obligation_settlements s JOIN bank_transactions t ON t.id = s.bank_transaction_id AND t.company_id = s.company_id
       WHERE s.obligation_id = $1 AND s.company_id = $2 ORDER BY t.transaction_date, s.created_at, s.id`, [header.obligation_id, companyId])).rows;
    // Linked credit/debit notes (read-only correction history). Registered through InvoiceAdjustmentService (external notes only).
    const adjustments = (await client.query(
      `SELECT a.id, a.adjustment_type, a.status, a.adjustment_date::text, a.external_number, a.subtotal_amount::text, a.vat_amount::text, a.total_amount::text, a.reason,
              j.id AS journal_id, j.status AS journal_status
       FROM invoice_adjustments a LEFT JOIN journal_entries j ON j.company_id = a.company_id AND j.source_type = 'invoice_adjustment' AND j.source_id = a.id
       WHERE a.original_invoice_id = $1 AND a.company_id = $2 ORDER BY a.created_at, a.id`, [invoiceId, companyId])).rows;
    return { ...(withLinked(header) as any), lines, settlements, adjustments } as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  /** Customer picker for sales invoices: active, non-supplier counterparties of the company, id/name/type only (same rule as checkReferences). */
  async listCustomers(companyId: string) {
    const rows = (await this.db.query<{ id: string; name: string; type: string }>(
      `SELECT id, name, type FROM counterparties WHERE company_id = $1 AND is_active = TRUE AND type <> 'supplier' ORDER BY name, id`, [companyId])).rows;
    return { customers: rows };
  }

  /** Supplier picker for purchase invoices: active, non-customer counterparties (the mirror of checkReferences for purchases). */
  async listSuppliers(companyId: string) {
    const rows = (await this.db.query<{ id: string; name: string; type: string }>(
      `SELECT id, name, type FROM counterparties WHERE company_id = $1 AND is_active = TRUE AND type <> 'customer' ORDER BY name, id`, [companyId])).rows;
    return { suppliers: rows };
  }

  async list(companyId: string, f: ListFilters) {
    const where = ['i.company_id = $1'];
    const params: unknown[] = [companyId];
    const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (f.direction) add('i.direction = ?', f.direction);
    if (f.status) add('i.status = ?', f.status);
    if (f.counterparty_id) add('i.counterparty_id = ?', f.counterparty_id);
    if (f.from) add('i.issue_date >= ?', f.from);
    if (f.to) add('i.issue_date <= ?', f.to);
    // Free-text search over the visible identifiers only (number, external reference, counterparty name, total); LIKE wildcards in the input are escaped.
    if (f.q) {
      params.push(`%${f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
      const p = `$${params.length}`;
      where.push(`(i.internal_number::text ILIKE ${p} OR i.external_reference ILIKE ${p} OR c.name ILIKE ${p} OR i.total_amount::text ILIKE ${p})`);
    }
    const condition = where.join(' AND ');
    const total = Number((await this.db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM invoices i JOIN counterparties c ON c.id = i.counterparty_id AND c.company_id = i.company_id WHERE ${condition}`, params)).rows[0]!.n);
    const rows = (await this.db.query(
      `SELECT ${HEADER_COLUMNS}, ${LINKED_COLUMNS}
       FROM invoices i JOIN counterparties c ON c.id = i.counterparty_id AND c.company_id = i.company_id${LINKED_JOINS}
       WHERE ${condition}
       ORDER BY i.issue_date DESC, i.created_at DESC, i.id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, f.limit, f.offset])).rows;
    return { invoices: rows.map(withLinked), total, limit: f.limit, offset: f.offset };
  }
}
