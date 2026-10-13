import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { operationalDate } from '../../operational-date';
import logger from '../../shared/logger';
import { DraftInput, InvoiceDraftService, InvoiceError, parseDraft } from './invoice.service';
import { addDays, anchorDayOf, firstOccurrenceOnOrAfter, Frequency, FREQUENCIES, nextOccurrence } from './recurrence';

/**
 * Recurring invoice templates (sales and purchase). A template only ever produces DRAFT invoices through the normal draft path
 * (InvoiceDraftService.createWithin), so every draft rule applies: company isolation, counterparty rules, VAT treatment / recoverability
 * coherence, the effective standard VAT rate for sales, and server-side amounts. Nothing here submits, approves, posts, settles or sends.
 * Idempotency is a database guarantee: invoices_recurrence_occurrence_uidx (migration 062) allows one invoice per (company, template, occurrence date),
 * and each generation holds the template row lock (FOR UPDATE SKIP LOCKED), so concurrent scheduler runs cannot both create it.
 */

type Direction = 'sales' | 'purchase';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CATCH_UP_PER_RUN = 12;

const invalid = (message: string) => new InvoiceError(400, 'INVOICE_VALIDATION', message);
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const validDate = (x: unknown, field: string): string => {
  if (typeof x !== 'string' || !DATE.test(x) || new Date(`${x}T00:00:00Z`).toISOString().slice(0, 10) !== x) throw invalid(`${field} must be a valid YYYY-MM-DD date`);
  return x;
};

export type TemplateInput = {
  name: string; counterparty_id: string; frequency: Frequency; start_date: string; end_date: string | null;
  due_days: number | null; notes: string | null; lines: unknown[];
};

const TEMPLATE_FIELDS = ['name', 'counterparty_id', 'frequency', 'start_date', 'end_date', 'due_days', 'notes', 'lines'];

/** Validates a template body. Lines go through the exact draft validation (parseDraft), so a template can never hold a line a draft would refuse. */
export function parseTemplate(body: unknown, extraKeys: string[] = []): TemplateInput {
  if (!isObject(body)) throw invalid('Request body must be an object');
  const extra = Object.keys(body).filter((k) => ![...TEMPLATE_FIELDS, ...extraKeys].includes(k));
  if (extra.length) throw invalid(`Template has unknown fields: ${extra.join(', ')}`);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 200) throw invalid('name is required (1 to 200 characters)');
  if (typeof body.counterparty_id !== 'string' || !UUID.test(body.counterparty_id)) throw invalid('counterparty_id must be a UUID');
  if (!FREQUENCIES.includes(body.frequency as Frequency)) throw invalid('frequency must be monthly, quarterly or annual');
  const start = validDate(body.start_date, 'start_date');
  const end = body.end_date == null ? null : validDate(body.end_date, 'end_date');
  if (end && end < start) throw invalid('end_date must not be before start_date');
  let dueDays: number | null = null;
  if (body.due_days != null) {
    if (!Number.isInteger(body.due_days) || (body.due_days as number) < 0 || (body.due_days as number) > 365) throw invalid('due_days must be an integer from 0 to 365');
    dueDays = body.due_days as number;
  }
  let notes: string | null = null;
  if (body.notes != null) {
    if (typeof body.notes !== 'string') throw invalid('notes must be text');
    notes = body.notes.trim() || null;
    if (notes && notes.length > 2000) throw invalid('notes must be at most 2000 characters');
  }
  // Lines are validated and normalized by the draft parser; amounts it computes are discarded (a template stores inputs only).
  const parsed = parseDraft({ counterparty_id: body.counterparty_id, issue_date: start, lines: body.lines });
  return { name, counterparty_id: body.counterparty_id, frequency: body.frequency as Frequency, start_date: start, end_date: end, due_days: dueDays, notes, lines: parsed.lines };
}

type TemplateRow = {
  id: string; company_id: string; direction: Direction; name: string; counterparty_id: string; frequency: Frequency;
  start_date: string; end_date: string | null; anchor_day: number; next_run_date: string; status: 'active' | 'paused' | 'ended';
  due_days: number | null; notes: string | null; last_generated_for: string | null; last_attempt_at: string | null; last_error_code: string | null;
  version: number; created_by_user_id: string; ended_by_user_id: string | null; ended_at: string | null; created_at: string; updated_at: string;
};
const COLUMNS = `t.id, t.company_id, t.direction, t.name, t.counterparty_id, t.frequency, t.start_date::text, t.end_date::text, t.anchor_day,
  t.next_run_date::text, t.status, t.due_days, t.notes, t.last_generated_for::text, t.last_attempt_at, t.last_error_code, t.version,
  t.created_by_user_id, t.ended_by_user_id, t.ended_at, t.created_at, t.updated_at`;

export type GenerationResult = { template_id: string; generated: Array<{ occurrence_date: string; invoice_id: string }>; skipped_existing: string[]; error_code: string | null };

export class RecurringInvoiceService {
  private readonly audit = new AuditLogRepository();
  private readonly drafts: InvoiceDraftService;
  constructor(private readonly db: Pool) { this.drafts = new InvoiceDraftService(db); }

  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async checkCounterparty(client: PoolClient, companyId: string, direction: Direction, counterpartyId: string) {
    const cp = (await client.query<{ type: string; is_active: boolean }>('SELECT type, is_active FROM counterparties WHERE id = $1 AND company_id = $2', [counterpartyId, companyId])).rows[0];
    if (!cp || !cp.is_active) throw new InvoiceError(400, 'INVOICE_COUNTERPARTY_INVALID', 'Counterparty not found or inactive');
    if ((direction === 'sales' && cp.type === 'supplier') || (direction === 'purchase' && cp.type === 'customer')) {
      throw new InvoiceError(400, 'INVOICE_COUNTERPARTY_INVALID', `Counterparty type ${cp.type} cannot be used on a ${direction} invoice`);
    }
  }

  private assertRecoverabilityDirection(direction: Direction, lines: unknown[]) {
    if (direction === 'sales' && (lines as Array<{ vat_recoverability: unknown; vat_recoverable_percent: unknown }>).some((l) => l.vat_recoverability !== null || l.vat_recoverable_percent !== null)) {
      throw invalid('vat_recoverability and vat_recoverable_percent apply only to purchase invoice lines');
    }
  }

  private async writeLines(client: PoolClient, companyId: string, templateId: string, lines: unknown[]) {
    let n = 0;
    for (const raw of lines as Array<Record<string, string | null>>) {
      n += 1;
      await client.query(
        `INSERT INTO recurring_invoice_template_lines (company_id, template_id, line_number, description, quantity, unit_price, discount_amount, vat_rate, vat_treatment, treatment_note, vat_recoverability, vat_recoverable_percent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [companyId, templateId, n, raw.description, raw.quantity, raw.unit_price, raw.discount_amount, raw.vat_rate, raw.vat_treatment, raw.treatment_note, raw.vat_recoverability, raw.vat_recoverable_percent]);
    }
  }

  private async read(client: PoolClient | Pool, companyId: string, id: string, lock = false) {
    const header = (await client.query<TemplateRow & { counterparty_name: string }>(
      `SELECT ${COLUMNS}, c.name AS counterparty_name FROM recurring_invoice_templates t
       JOIN counterparties c ON c.id = t.counterparty_id AND c.company_id = t.company_id
       WHERE t.id = $1 AND t.company_id = $2${lock ? ' FOR UPDATE OF t' : ''}`, [id, companyId])).rows[0];
    if (!header) return null;
    const lines = (await client.query(
      `SELECT line_number, description, quantity::text, unit_price::text, discount_amount::text, vat_rate::text, vat_treatment, treatment_note, vat_recoverability, vat_recoverable_percent::text
       FROM recurring_invoice_template_lines WHERE template_id = $1 AND company_id = $2 ORDER BY line_number`, [id, companyId])).rows;
    return { ...header, lines };
  }

  async list(companyId: string, filters: { direction: Direction | null; status: string | null }) {
    const where = ['t.company_id = $1']; const params: unknown[] = [companyId];
    if (filters.direction) { params.push(filters.direction); where.push(`t.direction = $${params.length}`); }
    if (filters.status) { params.push(filters.status); where.push(`t.status = $${params.length}`); }
    const rows = (await this.db.query(
      `SELECT ${COLUMNS}, c.name AS counterparty_name,
         (SELECT COALESCE(SUM(l.quantity * l.unit_price - l.discount_amount), 0)::text FROM recurring_invoice_template_lines l WHERE l.template_id = t.id AND l.company_id = t.company_id) AS net_estimate
       FROM recurring_invoice_templates t JOIN counterparties c ON c.id = t.counterparty_id AND c.company_id = t.company_id
       WHERE ${where.join(' AND ')} ORDER BY CASE t.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, t.next_run_date, t.created_at LIMIT 200`, params)).rows;
    return { templates: rows };
  }

  async get(companyId: string, id: string) {
    const template = await this.read(this.db, companyId, id);
    if (!template) throw new InvoiceError(404, 'RECURRING_NOT_FOUND', 'Recurring template not found');
    const generated = (await this.db.query(
      `SELECT id, internal_number, status, recurrence_occurrence_date::text AS occurrence_date, issue_date::text, total_amount::text
       FROM invoices WHERE company_id = $1 AND recurring_template_id = $2 ORDER BY recurrence_occurrence_date DESC LIMIT 24`, [companyId, id])).rows;
    return { ...template, generated_invoices: generated };
  }

  async create(companyId: string, actorUserId: string, direction: Direction, input: TemplateInput) {
    return this.tx(async (client) => {
      this.assertRecoverabilityDirection(direction, input.lines);
      if (input.start_date < operationalDate()) throw invalid('start_date must not be in the past');
      await this.checkCounterparty(client, companyId, direction, input.counterparty_id);
      const id = (await client.query<{ id: string }>(
        `INSERT INTO recurring_invoice_templates (company_id, direction, name, counterparty_id, frequency, start_date, end_date, anchor_day, next_run_date, due_days, notes, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,$10,$11) RETURNING id`,
        [companyId, direction, input.name, input.counterparty_id, input.frequency, input.start_date, input.end_date, anchorDayOf(input.start_date), input.due_days, input.notes, actorUserId])).rows[0]!.id;
      await this.writeLines(client, companyId, id, input.lines);
      const after = await this.read(client, companyId, id);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'recurring_invoice.create', entity_type: 'recurring_invoice_template', entity_id: id, before_data: null, after_data: after as never }, client);
      return after!;
    });
  }

  /** Replaces the editable fields and lines of an active or paused template. Direction never changes; the schedule (start / frequency) is locked once a draft exists. */
  async update(companyId: string, actorUserId: string, id: string, expectedVersion: number, input: TemplateInput) {
    return this.tx(async (client) => {
      const before = await this.read(client, companyId, id, true);
      if (!before) throw new InvoiceError(404, 'RECURRING_NOT_FOUND', 'Recurring template not found');
      if (before.status === 'ended') throw new InvoiceError(409, 'RECURRING_INVALID_STATE', 'An ended schedule cannot be edited');
      if (before.version !== expectedVersion) throw new InvoiceError(409, 'RECURRING_VERSION_CONFLICT', 'The schedule was changed by someone else; reload and try again');
      this.assertRecoverabilityDirection(before.direction, input.lines);
      await this.checkCounterparty(client, companyId, before.direction, input.counterparty_id);
      const scheduleChanged = input.start_date !== before.start_date || input.frequency !== before.frequency;
      let nextRun = before.next_run_date;
      if (scheduleChanged) {
        if (before.last_generated_for) throw new InvoiceError(409, 'RECURRING_SCHEDULE_LOCKED', 'The start date and frequency cannot change after drafts were generated; end this schedule and create a new one');
        if (input.start_date < operationalDate()) throw invalid('start_date must not be in the past');
        nextRun = input.start_date;
      }
      if (input.end_date && input.end_date < nextRun) throw invalid('end_date must not be before the next scheduled date; end the schedule instead');
      await client.query(
        `UPDATE recurring_invoice_templates SET name=$3, counterparty_id=$4, frequency=$5, start_date=$6, end_date=$7, anchor_day=$8, next_run_date=$9, due_days=$10, notes=$11,
           last_error_code=NULL, version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2`,
        [id, companyId, input.name, input.counterparty_id, input.frequency, input.start_date, input.end_date, anchorDayOf(input.start_date), nextRun, input.due_days, input.notes]);
      await client.query('DELETE FROM recurring_invoice_template_lines WHERE template_id=$1 AND company_id=$2', [id, companyId]);
      await this.writeLines(client, companyId, id, input.lines);
      const after = await this.read(client, companyId, id);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: 'recurring_invoice.update', entity_type: 'recurring_invoice_template', entity_id: id, before_data: before as never, after_data: after as never }, client);
      return after!;
    });
  }

  private async transition(companyId: string, actorUserId: string, id: string, expectedVersion: number, action: 'pause' | 'resume' | 'end') {
    return this.tx(async (client) => {
      const before = await this.read(client, companyId, id, true);
      if (!before) throw new InvoiceError(404, 'RECURRING_NOT_FOUND', 'Recurring template not found');
      if (before.version !== expectedVersion) throw new InvoiceError(409, 'RECURRING_VERSION_CONFLICT', 'The schedule was changed by someone else; reload and try again');
      const allowed = action === 'pause' ? before.status === 'active' : action === 'resume' ? before.status === 'paused' : before.status !== 'ended';
      if (!allowed) throw new InvoiceError(409, 'RECURRING_INVALID_STATE', `A ${before.status} schedule cannot be ${action === 'end' ? 'ended' : action + 'd'}`);
      if (action === 'pause') {
        await client.query("UPDATE recurring_invoice_templates SET status='paused', version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2", [id, companyId]);
      } else if (action === 'end') {
        await client.query("UPDATE recurring_invoice_templates SET status='ended', ended_at=NOW(), ended_by_user_id=$3, version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2", [id, companyId, actorUserId]);
      } else {
        // Resume never back-fills the paused interval: the schedule continues from the first occurrence on or after today.
        const next = firstOccurrenceOnOrAfter(before.next_run_date, operationalDate(), before.frequency, before.anchor_day);
        if (before.end_date && next > before.end_date) {
          await client.query("UPDATE recurring_invoice_templates SET status='ended', next_run_date=$3, ended_at=NOW(), ended_by_user_id=$4, version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2", [id, companyId, next, actorUserId]);
        } else {
          await client.query("UPDATE recurring_invoice_templates SET status='active', next_run_date=$3, last_error_code=NULL, version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2", [id, companyId, next]);
        }
      }
      const after = await this.read(client, companyId, id);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actorUserId, action: `recurring_invoice.${action}`, entity_type: 'recurring_invoice_template', entity_id: id, before_data: before as never, after_data: after as never }, client);
      return after!;
    });
  }
  pause(companyId: string, actorUserId: string, id: string, version: number) { return this.transition(companyId, actorUserId, id, version, 'pause'); }
  resume(companyId: string, actorUserId: string, id: string, version: number) { return this.transition(companyId, actorUserId, id, version, 'resume'); }
  end(companyId: string, actorUserId: string, id: string, version: number) { return this.transition(companyId, actorUserId, id, version, 'end'); }

  /**
   * Generates every DUE occurrence (scheduled date on or before asOf) of one template, oldest first, one transaction per occurrence.
   * Each transaction locks the template row, so a concurrent run either waits out of the way (SKIP LOCKED) or finds the schedule already advanced.
   * Generation stops at the first failure and records its code on the template; the occurrence is retried on the next run and is never skipped silently.
   */
  async generateForTemplate(templateId: string, asOf: string = operationalDate(), companyId: string | null = null): Promise<GenerationResult> {
    const result: GenerationResult = { template_id: templateId, generated: [], skipped_existing: [], error_code: null };
    for (let i = 0; i < MAX_CATCH_UP_PER_RUN; i += 1) {
      let outcome: { kind: 'generated' | 'existing' | 'stop'; occurrence?: string; invoiceId?: string };
      try {
        outcome = await this.tx(async (client) => {
          const row = (await client.query<TemplateRow>(
            `SELECT ${COLUMNS} FROM recurring_invoice_templates t WHERE t.id = $1 AND ($2::uuid IS NULL OR t.company_id = $2) FOR UPDATE SKIP LOCKED`, [templateId, companyId])).rows[0];
          if (!row || row.status !== 'active' || row.next_run_date > asOf) return { kind: 'stop' as const };
          const occurrence = row.next_run_date;
          const lines = (await client.query(
            `SELECT description, quantity::text, unit_price::text, discount_amount::text, vat_rate::text, vat_treatment, treatment_note, vat_recoverability, vat_recoverable_percent::text
             FROM recurring_invoice_template_lines WHERE template_id = $1 AND company_id = $2 ORDER BY line_number`, [row.id, row.company_id])).rows;
          const existing = (await client.query<{ id: string }>(
            "SELECT id FROM invoices WHERE company_id=$1 AND recurring_template_id=$2 AND recurrence_occurrence_date=$3 AND origin='recurring'", [row.company_id, row.id, occurrence])).rows[0];
          let invoiceId: string | null = existing?.id ?? null;
          if (!invoiceId) {
            const input: DraftInput = parseDraft({
              counterparty_id: row.counterparty_id, issue_date: occurrence, tax_point_date: occurrence, notes: row.notes,
              due_date: row.due_days == null ? null : addDays(occurrence, row.due_days), lines,
            });
            const invoice = await this.drafts.createWithin(client, row.company_id, row.created_by_user_id, row.direction, input, { templateId: row.id, occurrenceDate: occurrence });
            invoiceId = invoice.id as string;
            await this.audit.logEvent({ company_id: row.company_id, actor_user_id: row.created_by_user_id, action: 'recurring_invoice.generate', entity_type: 'recurring_invoice_template', entity_id: row.id,
              before_data: null, after_data: { template_id: row.id, invoice_id: invoiceId, occurrence_date: occurrence, trigger: 'schedule' } as never }, client);
          }
          const next = nextOccurrence(occurrence, row.frequency, row.anchor_day);
          const finished = row.end_date !== null && next > row.end_date;
          await client.query(
            `UPDATE recurring_invoice_templates SET next_run_date=$3, last_generated_for=$4, last_attempt_at=NOW(), last_error_code=NULL, version=version+1, updated_at=NOW(),
               status=CASE WHEN $5 THEN 'ended' ELSE status END, ended_at=CASE WHEN $5 THEN NOW() ELSE ended_at END
             WHERE id=$1 AND company_id=$2`, [row.id, row.company_id, next, occurrence, finished]);
          return { kind: existing ? ('existing' as const) : ('generated' as const), occurrence, invoiceId };
        });
      } catch (error) {
        const code = error instanceof InvoiceError ? error.code : 'RECURRING_GENERATION_FAILED';
        result.error_code = code;
        await this.db.query('UPDATE recurring_invoice_templates SET last_attempt_at=NOW(), last_error_code=$2 WHERE id=$1', [templateId, code]);
        if (!(error instanceof InvoiceError)) throw error;
        return result;
      }
      if (outcome.kind === 'stop') break;
      if (outcome.kind === 'existing') result.skipped_existing.push(outcome.occurrence!); else result.generated.push({ occurrence_date: outcome.occurrence!, invoice_id: outcome.invoiceId! });
    }
    return result;
  }

  /** Company-scoped manual run (the "generate due drafts now" action). The scheduler uses runAllDue. */
  async runDueForCompany(companyId: string, asOf: string = operationalDate()) {
    const ids = (await this.db.query<{ id: string }>("SELECT id FROM recurring_invoice_templates WHERE company_id=$1 AND status='active' AND next_run_date <= $2 ORDER BY next_run_date, id", [companyId, asOf])).rows;
    const results: GenerationResult[] = [];
    for (const { id } of ids) results.push(await this.generateForTemplate(id, asOf, companyId));
    return results;
  }

  /** Scheduler entry point: every company, bounded by the operational date. Safe to run from several processes at once. */
  async runAllDue(asOf: string = operationalDate()) {
    const ids = (await this.db.query<{ id: string }>("SELECT id FROM recurring_invoice_templates WHERE status='active' AND next_run_date <= $1 ORDER BY next_run_date, id LIMIT 500", [asOf])).rows;
    const results: GenerationResult[] = [];
    for (const { id } of ids) {
      try { results.push(await this.generateForTemplate(id, asOf)); } catch (error) { logger.error({ err: error, templateId: id }, 'Recurring invoice generation failed'); results.push({ template_id: id, generated: [], skipped_existing: [], error_code: 'RECURRING_GENERATION_FAILED' }); }
    }
    return results;
  }
}
