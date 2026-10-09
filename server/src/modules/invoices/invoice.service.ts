import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { computeLine, computeTotals, InvoiceMathError, LineAmounts } from './invoice-math';

/**
 * Sales and purchase invoice DRAFTS (PR-2B). Drafts have no accounting, VAT or obligation effect.
 * Out of scope here: submission, approval/numbering, posting, VAT recognition, payments, credit notes.
 * Every query is scoped by company_id; composite foreign keys (migration 062) back this up in the database.
 */

export type InvoiceErrorCode =
  | 'INVOICE_VALIDATION' | 'INVOICE_NOT_FOUND' | 'INVOICE_NOT_DRAFT' | 'INVOICE_NOT_SUBMITTED' | 'INVOICE_EMPTY' | 'INVOICE_VERSION_CONFLICT'
  | 'INVOICE_ALREADY_APPROVED' | 'INVOICE_FORBIDDEN' | 'INVOICE_MAPPING_MISSING' | 'INVOICE_VAT_PREREQUISITE' | 'INVOICE_SELF_APPROVAL' | 'INVOICE_FISCAL_YEAR_UNRESOLVED' | 'INVOICE_FISCAL_YEAR_CLOSED' | 'INVOICE_PERIOD_CLOSED'
  | 'INVOICE_DUPLICATE_REFERENCE' | 'INVOICE_SOURCE_ALREADY_LINKED' | 'INVOICE_COUNTERPARTY_INVALID' | 'INVOICE_DOCUMENT_INVALID';

export class InvoiceError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: InvoiceErrorCode, message: string) { super(message); }
}

const invalid = (message: string) => new InvoiceError(400, 'INVOICE_VALIDATION', message);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINES = 200;
const DIRECTIONS = ['sales', 'purchase'] as const;
const STATUSES = ['draft', 'submitted', 'approved', 'cancelled'] as const;
type Direction = (typeof DIRECTIONS)[number];

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
  counterparty_id: string; issue_date: string; due_date: string | null; supply_date: string | null;
  external_reference: string | null; notes: string | null; source_document_id: string | null;
  lines: Array<LineAmounts & { description: string }>;
  totals: { subtotal_amount: string; vat_amount: string; total_amount: string };
};

const DRAFT_FIELDS = ['counterparty_id', 'issue_date', 'due_date', 'supply_date', 'external_reference', 'notes', 'source_document_id', 'lines'];

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
    onlyKeys(raw, ['description', 'quantity', 'unit_price', 'discount_amount', 'vat_rate'], `lines[${i}]`);
    try {
      return { description: text(raw.description, `lines[${i}].description`, 500, true)!, ...computeLine(raw as never) };
    } catch (error) {
      if (error instanceof InvoiceMathError) throw invalid(`lines[${i}]: ${error.message}`);
      throw error;
    }
  });
  let totals;
  try { totals = computeTotals(lines); } catch (error) { if (error instanceof InvoiceMathError) throw invalid(error.message); throw error; }
  return {
    counterparty_id: uuid(body.counterparty_id, 'counterparty_id'),
    issue_date: issue, due_date: due, supply_date: optionalDate(body.supply_date, 'supply_date'),
    external_reference: text(body.external_reference, 'external_reference', 100),
    notes: text(body.notes, 'notes', 2000),
    source_document_id: optionalUuid(body.source_document_id, 'source_document_id'),
    lines, totals,
  };
}

export type ListFilters = {
  direction: Direction | null; status: string | null; counterparty_id: string | null;
  from: string | null; to: string | null; limit: number; offset: number;
};

export function parseListQuery(query: Record<string, unknown>): ListFilters {
  onlyKeys(query, ['direction', 'status', 'counterparty_id', 'from', 'to', 'limit', 'offset'], 'Query');
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
  return {
    direction: (direction as Direction) ?? null, status: (status as string) ?? null,
    counterparty_id: optionalUuid(one(query.counterparty_id), 'counterparty_id'), from, to,
    limit: int(one(query.limit), 'limit', 50, 1, 100), offset: int(one(query.offset), 'offset', 0, 0, 100000),
  };
}

const HEADER_COLUMNS = `i.id, i.company_id, i.direction, i.status, i.counterparty_id, c.name AS counterparty_name, i.fiscal_year_id,
  i.internal_number, i.external_reference, i.issue_date::text, i.due_date::text, i.supply_date::text, i.currency,
  i.subtotal_amount::text, i.vat_amount::text, i.total_amount::text, i.notes, i.origin, i.created_by_user_id,
  i.version, i.created_at, i.updated_at`;

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
        `INSERT INTO invoice_lines (company_id, invoice_id, line_number, description, quantity, unit_price, discount_amount, vat_rate, net_amount, vat_amount, total_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [companyId, invoiceId, n, line.description, line.quantity, line.unit_price, line.discount_amount, line.vat_rate, line.net_amount, line.vat_amount, line.total_amount],
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
    return this.tx(async (client) => {
      await this.checkReferences(client, companyId, direction, input, null);
      const id = (await client.query<{ id: string }>(
        `INSERT INTO invoices (company_id, direction, status, counterparty_id, external_reference, issue_date, due_date, supply_date,
           subtotal_amount, vat_amount, total_amount, notes, created_by_user_id)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [companyId, direction, input.counterparty_id, input.external_reference, input.issue_date, input.due_date, input.supply_date,
          input.totals.subtotal_amount, input.totals.vat_amount, input.totals.total_amount, input.notes, actorUserId],
      )).rows[0]!.id;
      await this.writeChildren(client, companyId, id, actorUserId, input);
      const after = await this.read(client, companyId, id);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'invoice.draft.create', entity_type: 'invoice', entity_id: id, before_data: null, after_data: after as never }, client);
      return after!;
    });
  }

  /** Full replacement of a draft's editable fields and lines, guarded by optimistic version. Direction is immutable. */
  async update(companyId: string, actorUserId: string, invoiceId: string, expectedVersion: number, input: DraftInput) {
    return this.tx(async (client) => {
      const current = (await client.query<{ status: string; version: number; direction: Direction }>(
        'SELECT status, version, direction FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [invoiceId, companyId])).rows[0];
      if (!current) throw new InvoiceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
      if (current.status !== 'draft') throw new InvoiceError(409, 'INVOICE_NOT_DRAFT', 'Only draft invoices can be edited');
      if (current.version !== expectedVersion) throw new InvoiceError(409, 'INVOICE_VERSION_CONFLICT', 'The invoice was changed by someone else; reload and try again');
      await this.checkReferences(client, companyId, current.direction, input, invoiceId);
      const before = await this.read(client, companyId, invoiceId);
      await client.query('DELETE FROM invoice_lines WHERE invoice_id = $1 AND company_id = $2', [invoiceId, companyId]);
      await client.query('DELETE FROM invoice_source_links WHERE invoice_id = $1 AND company_id = $2', [invoiceId, companyId]);
      await client.query(
        `UPDATE invoices SET counterparty_id=$3, external_reference=$4, issue_date=$5, due_date=$6, supply_date=$7,
           subtotal_amount=$8, vat_amount=$9, total_amount=$10, notes=$11, version = version + 1, updated_at = NOW()
         WHERE id = $1 AND company_id = $2 AND status = 'draft'`,
        [invoiceId, companyId, input.counterparty_id, input.external_reference, input.issue_date, input.due_date, input.supply_date,
          input.totals.subtotal_amount, input.totals.vat_amount, input.totals.total_amount, input.notes],
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
      `SELECT ${HEADER_COLUMNS}, l.document_id AS source_document_id
       FROM invoices i
       JOIN counterparties c ON c.id = i.counterparty_id AND c.company_id = i.company_id
       LEFT JOIN invoice_source_links l ON l.invoice_id = i.id AND l.company_id = i.company_id
       WHERE i.id = $1 AND i.company_id = $2`, [invoiceId, companyId])).rows[0];
    if (!header) return null;
    const lines = (await client.query(
      `SELECT line_number, description, quantity::text, unit_price::text, discount_amount::text, vat_rate::text,
              net_amount::text, vat_amount::text, total_amount::text
       FROM invoice_lines WHERE invoice_id = $1 AND company_id = $2 ORDER BY line_number`, [invoiceId, companyId])).rows;
    return { ...header, lines };
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
    const condition = where.join(' AND ');
    const total = Number((await this.db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM invoices i WHERE ${condition}`, params)).rows[0]!.n);
    const rows = (await this.db.query(
      `SELECT ${HEADER_COLUMNS}
       FROM invoices i JOIN counterparties c ON c.id = i.counterparty_id AND c.company_id = i.company_id
       WHERE ${condition}
       ORDER BY i.issue_date DESC, i.created_at DESC, i.id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, f.limit, f.offset])).rows;
    return { invoices: rows, total, limit: f.limit, offset: f.offset };
  }
}
