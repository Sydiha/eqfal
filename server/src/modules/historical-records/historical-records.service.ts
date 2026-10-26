import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';

// C5-P3: services for historical financial records on the approved migration 096 schema. Records only: nothing here reads or writes journals,
// opening balances, fiscal years or closed periods. Every mutation and its audit_log row share one transaction. The company always comes from
// the authenticated session (Actor), never from the request. Sealing, fingerprints and immutability are enforced by the database guards.

export type HistoricalCapability = 'historical.view' | 'historical.manage' | 'historical.approve';
export interface HistoricalActor { userId: string; companyId: string; capabilities: readonly string[] }

export class HistoricalError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
const bad = (code: string, message: string) => new HistoricalError(code, message, 400);
const notFound = (what: string) => new HistoricalError('NOT_FOUND', `${what} not found`, 404);

const STATEMENT_TYPES = ['financial_position', 'profit_or_loss', 'cash_flow', 'changes_in_equity', 'zakat_return', 'vat_return'];
const SOURCE_TYPES = ['bank_statement', 'customer_statement', 'supplier_statement', 'official_filing', 'prior_filing', 'original_document',
  'internal_ledger', 'management_reconciliation', 'manual_unverified'];
const CONFIDENCE = ['high', 'medium', 'low'];
const AMOUNT = /^-?\d{1,16}(\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = Record<string, unknown>;
const asBody = (v: unknown): Body => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad('HISTORICAL_INPUT_INVALID', 'Invalid request');
  return v as Body;
};
const onlyKeys = (b: Body, keys: string[]) => {
  for (const k of Object.keys(b)) if (!keys.includes(k)) throw bad('HISTORICAL_INPUT_INVALID', `Unexpected field: ${k}`);
};
function text(b: Body, key: string, max: number, required: boolean): string | null | undefined {
  const v = b[key];
  if (v === undefined) { if (required) throw bad('HISTORICAL_INPUT_INVALID', `${key} is required`); return undefined; }
  if (v === null) { if (required) throw bad('HISTORICAL_INPUT_INVALID', `${key} is required`); return null; }
  if (typeof v !== 'string' || v.trim().length < 1 || v.length > max) throw bad('HISTORICAL_INPUT_INVALID', `${key} is invalid`);
  return v.trim();
}
function oneOf(b: Body, key: string, allowed: string[], required: boolean): string | undefined {
  const v = b[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v)) throw bad('HISTORICAL_INPUT_INVALID', `${key} is invalid`);
  return v;
}
function date(b: Body, key: string, required: boolean): string | null | undefined {
  const v = b[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw bad('HISTORICAL_INPUT_INVALID', `${key} must be a valid YYYY-MM-DD date`);
  }
  return v;
}
function uuidOrNull(b: Body, key: string): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || !UUID.test(v)) throw bad('HISTORICAL_INPUT_INVALID', `${key} is invalid`);
  return v;
}
const reasonOf = (b: Body): string => text(b, 'reason', 500, true) as string;

const PERIOD_COLS = `id, company_id, label, period_start::text AS period_start, period_end::text AS period_end, completeness, reconstruction_status,
  status_reason, status_changed_by, status_changed_at, created_by, created_at`;
const VERSION_COLS = `id, company_id, period_id, kind, statement_type, version_no, state, functional_currency, submitted_to, submission_date::text AS submission_date,
  submission_reference, proof_level, proof_document_id, internal_purpose, basis_version_id, source_type, confidence, evidence_reference,
  evidence_document_id, method_note, fingerprint, sealed_by, sealed_at, review_status, reviewed_by, reviewed_at, approved_by, approved_at,
  void_reason, voided_by, voided_at, created_by, created_at`;
const LINE_COLS = `id, version_id, line_no, line_kind, line_code, label_ar, label_en, amount::text AS amount, supporting_document_id, note`;

/** What the record is, so officially submitted, declared, reconstructed and corrected data are never confused. */
export function provenanceOf(v: { kind: string; proof_level: string | null; internal_purpose: string | null }): string {
  if (v.kind === 'official') return v.proof_level === 'proof_attached' ? 'official_submitted_with_proof' : 'official_declared_unverified';
  return v.internal_purpose === 'correction' ? 'internal_correction' : 'internal_reconstruction';
}
const withProvenance = <T extends { kind: string; proof_level: string | null; internal_purpose: string | null }>(v: T) =>
  ({ ...v, provenance: provenanceOf(v), review_scope: 'internal_only', government_acceptance: 'not_implied' });

const DB_ERRORS: Record<string, [string, number]> = {
  HISTORICAL_PERIOD_OVERLAP: ['HISTORICAL_PERIOD_OVERLAP', 409],
  HISTORICAL_RECORD_IMMUTABLE: ['HISTORICAL_RECORD_IMMUTABLE', 409],
  HISTORICAL_STATUS_REASON_REQUIRED: ['HISTORICAL_STATUS_REASON_REQUIRED', 409],
  HISTORICAL_VERSION_EMPTY: ['HISTORICAL_VERSION_EMPTY', 409],
  HISTORICAL_BASIS_INVALID: ['HISTORICAL_BASIS_INVALID', 409],
  HISTORICAL_VERSION_INVALID: ['HISTORICAL_VERSION_INVALID', 409],
};

function translate(error: unknown): unknown {
  if (error instanceof HistoricalError) return error;
  const e = error as { code?: string; message?: string; constraint?: string };
  for (const [marker, [code, status]] of Object.entries(DB_ERRORS)) {
    if (e.message?.includes(marker)) return new HistoricalError(code, e.message.replace(/^error: /i, ''), status);
  }
  if (e.code === '23505') {
    if (e.constraint?.includes('period_start')) return new HistoricalError('HISTORICAL_PERIOD_DUPLICATE', 'A period with these dates already exists', 409);
    if (e.constraint?.includes('line_code')) return new HistoricalError('HISTORICAL_LINE_DUPLICATE', 'This line code already exists in the version', 409);
    if (e.constraint?.includes('line_no')) return new HistoricalError('HISTORICAL_LINE_DUPLICATE', 'This line number already exists in the version', 409);
    return new HistoricalError('HISTORICAL_VERSION_CONFLICT', 'The record conflicts with an existing one; retry', 409);
  }
  if (e.code === '23514' || e.code === '23503') return new HistoricalError('HISTORICAL_VERSION_INVALID', 'The values violate the historical record rules', 422);
  return error;
}

export class HistoricalRecordsService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly pool: Pool) {}

  private need(actor: HistoricalActor, capability: HistoricalCapability): void {
    if (!actor.capabilities.includes(capability)) throw new HistoricalError('FORBIDDEN', 'Forbidden', 403);
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw translate(error);
    } finally { client.release(); }
  }

  private log(client: PoolClient, a: HistoricalActor, action: string, entityType: string, entityId: string,
    before: Record<string, unknown> | null, after: Record<string, unknown> | null, reason?: string | null) {
    return this.audit.logEvent({ company_id: a.companyId, actor_user_id: a.userId, action, entity_type: entityType, entity_id: entityId,
      before_data: before, after_data: after, reason: reason ?? null }, client);
  }

  private async lockPeriod(client: PoolClient, a: HistoricalActor, id: string) {
    const row = (await client.query(`SELECT ${PERIOD_COLS} FROM historical_periods WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, a.companyId])).rows[0];
    if (!row) throw notFound('Period');
    return row;
  }
  private async lockVersion(client: PoolClient, a: HistoricalActor, id: string) {
    const row = (await client.query(`SELECT ${VERSION_COLS} FROM historical_statement_versions WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, a.companyId])).rows[0];
    if (!row) throw notFound('Version');
    return row;
  }
  private async assertDocument(client: PoolClient, a: HistoricalActor, id: string | null | undefined): Promise<void> {
    if (!id) return;
    const found = (await client.query('SELECT 1 FROM documents WHERE id = $1 AND company_id = $2', [id, a.companyId])).rowCount;
    if (!found) throw new HistoricalError('HISTORICAL_DOCUMENT_NOT_FOUND', 'Document not found in this company', 422);
  }
  /** Internal reconstruction work stops once the period's reconstruction is completed; it resumes only after an approved reopen. */
  private assertInternalWorkOpen(period: { reconstruction_status: string }): void {
    if (period.reconstruction_status === 'completed') {
      throw new HistoricalError('HISTORICAL_RECONSTRUCTION_COMPLETED', 'Reconstruction is completed; reopen it first', 409);
    }
  }
  private static draftOnly(v: { state: string }): void {
    if (v.state !== 'draft') throw new HistoricalError('HISTORICAL_NOT_DRAFT', 'Only a draft version can change', 409);
  }

  // ---------------------------------------------------------------- periods

  async listPeriods(a: HistoricalActor) {
    this.need(a, 'historical.view');
    return (await this.pool.query(
      `SELECT ${PERIOD_COLS}, (SELECT COUNT(*)::int FROM historical_statement_versions v WHERE v.period_id = historical_periods.id) AS version_count
         FROM historical_periods WHERE company_id = $1 ORDER BY period_start DESC`, [a.companyId])).rows;
  }

  async getPeriod(a: HistoricalActor, id: string) {
    this.need(a, 'historical.view');
    const period = (await this.pool.query(`SELECT ${PERIOD_COLS} FROM historical_periods WHERE id = $1 AND company_id = $2`, [id, a.companyId])).rows[0];
    if (!period) throw notFound('Period');
    const versions = (await this.pool.query(
      `SELECT ${VERSION_COLS} FROM historical_statement_versions WHERE period_id = $1 AND company_id = $2 ORDER BY statement_type, version_no`, [id, a.companyId])).rows;
    return { period, versions: versions.map(withProvenance) };
  }

  async createPeriod(a: HistoricalActor, input: unknown) {
    this.need(a, 'historical.manage');
    const b = asBody(input);
    onlyKeys(b, ['label', 'period_start', 'period_end', 'completeness', 'reason']);
    const label = text(b, 'label', 200, true) as string;
    const start = date(b, 'period_start', true) as string, end = date(b, 'period_end', true) as string;
    if (start >= end) throw bad('HISTORICAL_INPUT_INVALID', 'period_start must be before period_end');
    const completeness = oneOf(b, 'completeness', ['complete', 'incomplete'], true)!;
    const reason = reasonOf(b);
    return this.tx(async (client) => {
      const period = (await client.query(
        `INSERT INTO historical_periods (company_id, label, period_start, period_end, completeness, status_reason, status_changed_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING ${PERIOD_COLS}`, [a.companyId, label, start, end, completeness, reason, a.userId])).rows[0];
      await this.log(client, a, 'historical.period.create', 'historical_period', period.id, null, period, reason);
      return period;
    });
  }

  /** Completeness and the forward reconstruction steps (not_started -> in_progress -> completed). Reopening is a separate, approve-only action. */
  async updatePeriodStatus(a: HistoricalActor, id: string, input: unknown) {
    this.need(a, 'historical.manage');
    const b = asBody(input);
    onlyKeys(b, ['completeness', 'reconstruction_status', 'reason']);
    const completeness = oneOf(b, 'completeness', ['complete', 'incomplete'], false);
    const status = oneOf(b, 'reconstruction_status', ['in_progress', 'completed'], false);
    const reason = reasonOf(b);
    if (completeness === undefined && status === undefined) throw bad('HISTORICAL_INPUT_INVALID', 'Nothing to change');
    return this.tx(async (client) => {
      const before = await this.lockPeriod(client, a, id);
      if (status !== undefined) {
        const allowed = (before.reconstruction_status === 'not_started' && status === 'in_progress')
          || (before.reconstruction_status === 'in_progress' && status === 'completed');
        if (!allowed) throw new HistoricalError('HISTORICAL_STATUS_TRANSITION_INVALID', `Cannot move reconstruction from ${before.reconstruction_status} to ${status}`, 409);
      }
      const nextCompleteness = completeness ?? before.completeness, nextStatus = status ?? before.reconstruction_status;
      if (nextCompleteness === before.completeness && nextStatus === before.reconstruction_status) throw bad('HISTORICAL_INPUT_INVALID', 'Nothing to change');
      const after = (await client.query(
        `UPDATE historical_periods SET completeness = $3, reconstruction_status = $4, status_reason = $5, status_changed_by = $6, status_changed_at = clock_timestamp()
          WHERE id = $1 AND company_id = $2 RETURNING ${PERIOD_COLS}`, [id, a.companyId, nextCompleteness, nextStatus, reason, a.userId])).rows[0];
      await this.log(client, a, 'historical.period.status_change', 'historical_period', id, before, after, reason);
      return after;
    });
  }

  async reopenReconstruction(a: HistoricalActor, id: string, input: unknown) {
    this.need(a, 'historical.approve');
    const b = asBody(input);
    onlyKeys(b, ['reason', 'confirm']);
    const reason = reasonOf(b);
    return this.tx(async (client) => {
      const before = await this.lockPeriod(client, a, id);
      if (before.reconstruction_status !== 'completed') throw new HistoricalError('HISTORICAL_STATUS_TRANSITION_INVALID', 'Only a completed reconstruction can be reopened', 409);
      const after = (await client.query(
        `UPDATE historical_periods SET reconstruction_status = 'in_progress', status_reason = $3, status_changed_by = $4, status_changed_at = clock_timestamp()
          WHERE id = $1 AND company_id = $2 RETURNING ${PERIOD_COLS}`, [id, a.companyId, reason, a.userId])).rows[0];
      await this.log(client, a, 'historical.period.reconstruction_reopen', 'historical_period', id, before, after, reason);
      return after;
    });
  }

  // --------------------------------------------------------------- versions

  async listVersions(a: HistoricalActor, periodId: string, statementType?: string) {
    this.need(a, 'historical.view');
    if (statementType !== undefined && !STATEMENT_TYPES.includes(statementType)) throw bad('HISTORICAL_INPUT_INVALID', 'statement_type is invalid');
    const params: unknown[] = [periodId, a.companyId];
    if (statementType) params.push(statementType);
    const rows = (await this.pool.query(
      `SELECT ${VERSION_COLS} FROM historical_statement_versions WHERE period_id = $1 AND company_id = $2${statementType ? ' AND statement_type = $3' : ''}
        ORDER BY statement_type, version_no`, params)).rows;
    if (!rows.length) {
      const exists = (await this.pool.query('SELECT 1 FROM historical_periods WHERE id = $1 AND company_id = $2', [periodId, a.companyId])).rowCount;
      if (!exists) throw notFound('Period');
    }
    return rows.map(withProvenance);
  }

  async getVersion(a: HistoricalActor, id: string) {
    this.need(a, 'historical.view');
    const version = (await this.pool.query(`SELECT ${VERSION_COLS} FROM historical_statement_versions WHERE id = $1 AND company_id = $2`, [id, a.companyId])).rows[0];
    if (!version) throw notFound('Version');
    const lines = (await this.pool.query(`SELECT ${LINE_COLS} FROM historical_statement_lines WHERE version_id = $1 AND company_id = $2 ORDER BY line_no`, [id, a.companyId])).rows;
    return { version: withProvenance(version), lines };
  }

  /** The chain of versions of one statement in one period, oldest first, with each version's basis. Read-only. */
  async history(a: HistoricalActor, id: string) {
    this.need(a, 'historical.view');
    const v = (await this.pool.query('SELECT period_id, statement_type FROM historical_statement_versions WHERE id = $1 AND company_id = $2', [id, a.companyId])).rows[0];
    if (!v) throw notFound('Version');
    const versions = await this.listVersions(a, v.period_id, v.statement_type);
    return { period_id: v.period_id, statement_type: v.statement_type, versions };
  }

  async createVersion(a: HistoricalActor, periodId: string, input: unknown) {
    this.need(a, 'historical.manage');
    const b = asBody(input);
    const kind = oneOf(b, 'kind', ['official', 'internal'], true)!;
    const common = ['kind', 'statement_type', 'functional_currency'];
    const fields = kind === 'official'
      ? [...common, 'submitted_to', 'submission_date', 'submission_reference', 'proof_level', 'proof_document_id']
      : [...common, 'internal_purpose', 'basis_version_id', 'source_type', 'confidence', 'evidence_reference', 'evidence_document_id', 'method_note'];
    onlyKeys(b, fields);
    const statementType = oneOf(b, 'statement_type', STATEMENT_TYPES, true)!;
    const currency = b['functional_currency'];
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw bad('HISTORICAL_INPUT_INVALID', 'functional_currency must be a 3-letter code');
    const values: Record<string, unknown> = {};
    if (kind === 'official') {
      values['submitted_to'] = text(b, 'submitted_to', 200, true);
      values['submission_date'] = date(b, 'submission_date', true);
      values['submission_reference'] = text(b, 'submission_reference', 200, false) ?? null;
      values['proof_level'] = oneOf(b, 'proof_level', ['proof_attached', 'declared_unverified'], true);
      values['proof_document_id'] = uuidOrNull(b, 'proof_document_id') ?? null;
    } else {
      // Corrections have their own endpoint so that the original is never touched and the basis is always explicit.
      values['internal_purpose'] = oneOf(b, 'internal_purpose', ['reconstruction'], true);
      values['basis_version_id'] = uuidOrNull(b, 'basis_version_id') ?? null;
      values['source_type'] = oneOf(b, 'source_type', SOURCE_TYPES, true);
      values['confidence'] = oneOf(b, 'confidence', CONFIDENCE, true);
      values['evidence_reference'] = text(b, 'evidence_reference', 500, false) ?? null;
      values['evidence_document_id'] = uuidOrNull(b, 'evidence_document_id') ?? null;
      values['method_note'] = text(b, 'method_note', 2000, false) ?? null;
    }
    return this.tx(async (client) => {
      const period = await this.lockPeriod(client, a, periodId);
      if (kind === 'internal') this.assertInternalWorkOpen(period);
      await this.assertDocument(client, a, (values['proof_document_id'] ?? values['evidence_document_id']) as string | null);
      const next = (await client.query(
        'SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM historical_statement_versions WHERE period_id = $1 AND statement_type = $2', [periodId, statementType])).rows[0].n;
      const cols = ['company_id', 'period_id', 'kind', 'statement_type', 'version_no', 'functional_currency', 'created_by', ...Object.keys(values)];
      const params = [a.companyId, periodId, kind, statementType, next, currency, a.userId, ...Object.values(values)];
      const row = (await client.query(
        `INSERT INTO historical_statement_versions (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${VERSION_COLS}`, params)).rows[0];
      await this.log(client, a, 'historical.version.create', 'historical_version', row.id, null, row);
      return withProvenance(row);
    });
  }

  async updateDraft(a: HistoricalActor, id: string, input: unknown) {
    this.need(a, 'historical.manage');
    const b = asBody(input);
    const sets: Record<string, unknown> = {};
    const before0 = await this.pool.query('SELECT kind, internal_purpose FROM historical_statement_versions WHERE id = $1 AND company_id = $2', [id, a.companyId]);
    const meta = before0.rows[0];
    if (!meta) throw notFound('Version');
    const official = meta.kind === 'official';
    const allowed = official
      ? ['functional_currency', 'submitted_to', 'submission_date', 'submission_reference', 'proof_level', 'proof_document_id']
      : ['functional_currency', 'source_type', 'confidence', 'evidence_reference', 'evidence_document_id', 'method_note',
        ...(meta.internal_purpose === 'reconstruction' ? ['basis_version_id'] : [])];
    onlyKeys(b, allowed);
    if (b['functional_currency'] !== undefined) {
      if (typeof b['functional_currency'] !== 'string' || !/^[A-Z]{3}$/.test(b['functional_currency'])) throw bad('HISTORICAL_INPUT_INVALID', 'functional_currency must be a 3-letter code');
      sets['functional_currency'] = b['functional_currency'];
    }
    if (official) {
      if (b['submitted_to'] !== undefined) sets['submitted_to'] = text(b, 'submitted_to', 200, true);
      if (b['submission_date'] !== undefined) sets['submission_date'] = date(b, 'submission_date', true);
      if (b['submission_reference'] !== undefined) sets['submission_reference'] = text(b, 'submission_reference', 200, false);
      if (b['proof_level'] !== undefined) sets['proof_level'] = oneOf(b, 'proof_level', ['proof_attached', 'declared_unverified'], true);
      if (b['proof_document_id'] !== undefined) sets['proof_document_id'] = uuidOrNull(b, 'proof_document_id');
    } else {
      if (b['basis_version_id'] !== undefined) sets['basis_version_id'] = uuidOrNull(b, 'basis_version_id');
      if (b['source_type'] !== undefined) sets['source_type'] = oneOf(b, 'source_type', SOURCE_TYPES, true);
      if (b['confidence'] !== undefined) sets['confidence'] = oneOf(b, 'confidence', CONFIDENCE, true);
      if (b['evidence_reference'] !== undefined) sets['evidence_reference'] = text(b, 'evidence_reference', 500, false);
      if (b['evidence_document_id'] !== undefined) sets['evidence_document_id'] = uuidOrNull(b, 'evidence_document_id');
      if (b['method_note'] !== undefined) sets['method_note'] = text(b, 'method_note', 2000, false);
    }
    const keys = Object.keys(sets);
    if (!keys.length) throw bad('HISTORICAL_INPUT_INVALID', 'Nothing to change');
    return this.tx(async (client) => {
      const before = await this.lockVersion(client, a, id);
      HistoricalRecordsService.draftOnly(before);
      await this.assertDocument(client, a, (sets['proof_document_id'] ?? sets['evidence_document_id']) as string | null | undefined);
      const after = (await client.query(
        `UPDATE historical_statement_versions SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND company_id = $2 RETURNING ${VERSION_COLS}`,
        [id, a.companyId, ...keys.map((k) => sets[k])])).rows[0];
      await this.log(client, a, 'historical.version.update', 'historical_version', id, before, after);
      return withProvenance(after);
    });
  }

  // ------------------------------------------------------------------ lines

  private parseLine(b: Body, partial: boolean): Record<string, unknown> {
    onlyKeys(b, ['line_no', 'line_code', 'label_ar', 'label_en', 'amount', 'supporting_document_id', 'note']);
    const out: Record<string, unknown> = {};
    const present = (k: string) => b[k] !== undefined;
    if (present('line_no')) {
      if (!Number.isInteger(b['line_no']) || (b['line_no'] as number) < 1) throw bad('HISTORICAL_INPUT_INVALID', 'line_no is invalid');
      out['line_no'] = b['line_no'];
    }
    if (!partial || present('line_code')) out['line_code'] = text(b, 'line_code', 100, true);
    if (present('label_ar')) out['label_ar'] = text(b, 'label_ar', 300, false);
    if (present('label_en')) out['label_en'] = text(b, 'label_en', 300, false);
    if (!partial || present('amount')) {
      if (typeof b['amount'] !== 'string' || !AMOUNT.test(b['amount'])) throw bad('HISTORICAL_INPUT_INVALID', 'amount must be a decimal string with at most 2 decimals');
      out['amount'] = b['amount'];
    }
    if (present('supporting_document_id')) out['supporting_document_id'] = uuidOrNull(b, 'supporting_document_id');
    if (present('note')) out['note'] = text(b, 'note', 1000, false);
    return out;
  }

  async addLine(a: HistoricalActor, versionId: string, input: unknown) {
    this.need(a, 'historical.manage');
    const values = this.parseLine(asBody(input), false);
    return this.tx(async (client) => {
      const version = await this.lockVersion(client, a, versionId);
      HistoricalRecordsService.draftOnly(version);
      await this.assertDocument(client, a, values['supporting_document_id'] as string | null | undefined);
      if (values['line_no'] === undefined) {
        values['line_no'] = (await client.query('SELECT COALESCE(MAX(line_no), 0) + 1 AS n FROM historical_statement_lines WHERE version_id = $1', [versionId])).rows[0].n;
      }
      if (values['label_ar'] == null && values['label_en'] == null) throw bad('HISTORICAL_INPUT_INVALID', 'label_ar or label_en is required');
      const cols = ['company_id', 'version_id', ...Object.keys(values)];
      const row = (await client.query(
        `INSERT INTO historical_statement_lines (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${LINE_COLS}`,
        [a.companyId, versionId, ...Object.values(values)])).rows[0];
      await this.log(client, a, 'historical.version.line_add', 'historical_version', versionId, null, row);
      return row;
    });
  }

  async updateLine(a: HistoricalActor, versionId: string, lineId: string, input: unknown) {
    this.need(a, 'historical.manage');
    const values = this.parseLine(asBody(input), true);
    const keys = Object.keys(values);
    if (!keys.length) throw bad('HISTORICAL_INPUT_INVALID', 'Nothing to change');
    return this.tx(async (client) => {
      HistoricalRecordsService.draftOnly(await this.lockVersion(client, a, versionId));
      await this.assertDocument(client, a, values['supporting_document_id'] as string | null | undefined);
      const before = (await client.query(`SELECT ${LINE_COLS} FROM historical_statement_lines WHERE id = $1 AND version_id = $2 AND company_id = $3 FOR UPDATE`, [lineId, versionId, a.companyId])).rows[0];
      if (!before) throw notFound('Line');
      const after = (await client.query(
        `UPDATE historical_statement_lines SET ${keys.map((k, i) => `${k} = $${i + 4}`).join(', ')} WHERE id = $1 AND version_id = $2 AND company_id = $3 RETURNING ${LINE_COLS}`,
        [lineId, versionId, a.companyId, ...keys.map((k) => values[k])])).rows[0];
      await this.log(client, a, 'historical.version.line_update', 'historical_version', versionId, before, after);
      return after;
    });
  }

  async removeLine(a: HistoricalActor, versionId: string, lineId: string) {
    this.need(a, 'historical.manage');
    return this.tx(async (client) => {
      HistoricalRecordsService.draftOnly(await this.lockVersion(client, a, versionId));
      const before = (await client.query(`DELETE FROM historical_statement_lines WHERE id = $1 AND version_id = $2 AND company_id = $3 RETURNING ${LINE_COLS}`, [lineId, versionId, a.companyId])).rows[0];
      if (!before) throw notFound('Line');
      await this.log(client, a, 'historical.version.line_remove', 'historical_version', versionId, before, null);
      return { removed: true };
    });
  }

  // ------------------------------------------------- seal / void / correction

  async seal(a: HistoricalActor, id: string) {
    this.need(a, 'historical.manage');
    return this.tx(async (client) => {
      const before = await this.lockVersion(client, a, id);
      HistoricalRecordsService.draftOnly(before);
      if (before.kind === 'internal') this.assertInternalWorkOpen(await this.lockPeriod(client, a, before.period_id));
      const after = (await client.query(
        `UPDATE historical_statement_versions SET state = 'sealed', sealed_by = $3, sealed_at = clock_timestamp() WHERE id = $1 AND company_id = $2 RETURNING ${VERSION_COLS}`,
        [id, a.companyId, a.userId])).rows[0];
      await this.log(client, a, 'historical.version.seal', 'historical_version', id, before, after);
      return withProvenance(after);
    });
  }

  async voidDraft(a: HistoricalActor, id: string, input: unknown) {
    this.need(a, 'historical.manage');
    const b = asBody(input);
    onlyKeys(b, ['reason', 'confirm']);
    const reason = reasonOf(b);
    return this.tx(async (client) => {
      const before = await this.lockVersion(client, a, id);
      HistoricalRecordsService.draftOnly(before);
      const after = (await client.query(
        `UPDATE historical_statement_versions SET state = 'voided', void_reason = $3, voided_by = $4, voided_at = clock_timestamp() WHERE id = $1 AND company_id = $2 RETURNING ${VERSION_COLS}`,
        [id, a.companyId, reason, a.userId])).rows[0];
      await this.log(client, a, 'historical.version.void', 'historical_version', id, before, after, reason);
      return withProvenance(after);
    });
  }

  /** New internal draft (purpose = correction) based on a sealed version, pre-filled with its lines. The original is never modified. */
  async createCorrection(a: HistoricalActor, basisId: string, input: unknown) {
    this.need(a, 'historical.manage');
    const b = asBody(input);
    onlyKeys(b, ['source_type', 'confidence', 'evidence_reference', 'evidence_document_id', 'method_note', 'confirm']);
    const source = oneOf(b, 'source_type', SOURCE_TYPES, true)!, confidence = oneOf(b, 'confidence', CONFIDENCE, true)!;
    const evidenceRef = text(b, 'evidence_reference', 500, false) ?? null, evidenceDoc = uuidOrNull(b, 'evidence_document_id') ?? null;
    const note = text(b, 'method_note', 2000, false) ?? null;
    return this.tx(async (client) => {
      const basis = await this.lockVersion(client, a, basisId);
      if (basis.state !== 'sealed') throw new HistoricalError('HISTORICAL_BASIS_INVALID', 'A correction needs a sealed version as its basis', 409);
      const period = await this.lockPeriod(client, a, basis.period_id);
      this.assertInternalWorkOpen(period);
      await this.assertDocument(client, a, evidenceDoc);
      const next = (await client.query(
        'SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM historical_statement_versions WHERE period_id = $1 AND statement_type = $2', [basis.period_id, basis.statement_type])).rows[0].n;
      const row = (await client.query(
        `INSERT INTO historical_statement_versions (company_id, period_id, kind, statement_type, version_no, functional_currency, internal_purpose, basis_version_id,
           source_type, confidence, evidence_reference, evidence_document_id, method_note, created_by)
         VALUES ($1,$2,'internal',$3,$4,$5,'correction',$6,$7,$8,$9,$10,$11,$12) RETURNING ${VERSION_COLS}`,
        [a.companyId, basis.period_id, basis.statement_type, next, basis.functional_currency, basisId, source, confidence, evidenceRef, evidenceDoc, note, a.userId])).rows[0];
      await client.query(
        `INSERT INTO historical_statement_lines (company_id, version_id, line_no, line_code, label_ar, label_en, amount, supporting_document_id, note)
         SELECT company_id, $2, line_no, line_code, label_ar, label_en, amount, supporting_document_id, note FROM historical_statement_lines WHERE version_id = $1`, [basisId, row.id]);
      await this.log(client, a, 'historical.version.correction_create', 'historical_version', row.id, null, { ...row, basis_version_id: basisId });
      return withProvenance(row);
    });
  }

  // ----------------------------------------------------------------- review

  /** Internal review only (none -> reviewed -> approved). It records EQFAL's own review; it never implies acceptance by any authority. */
  async review(a: HistoricalActor, id: string, input: unknown) {
    this.need(a, 'historical.approve');
    const b = asBody(input);
    onlyKeys(b, ['action', 'confirm']);
    const action = oneOf(b, 'action', ['review', 'approve'], true)!;
    return this.tx(async (client) => {
      const before = await this.lockVersion(client, a, id);
      if (before.state !== 'sealed') throw new HistoricalError('HISTORICAL_NOT_SEALED', 'Only a sealed version can be reviewed', 409);
      const from = action === 'review' ? 'none' : 'reviewed';
      if (before.review_status !== from) {
        throw new HistoricalError('HISTORICAL_REVIEW_TRANSITION_INVALID', `A version in review status ${before.review_status} cannot be ${action === 'review' ? 'reviewed' : 'approved'}`, 409);
      }
      const after = (await client.query(
        action === 'review'
          ? `UPDATE historical_statement_versions SET review_status = 'reviewed', reviewed_by = $3, reviewed_at = clock_timestamp() WHERE id = $1 AND company_id = $2 RETURNING ${VERSION_COLS}`
          : `UPDATE historical_statement_versions SET review_status = 'approved', approved_by = $3, approved_at = clock_timestamp() WHERE id = $1 AND company_id = $2 RETURNING ${VERSION_COLS}`,
        [id, a.companyId, a.userId])).rows[0];
      await this.log(client, a, action === 'review' ? 'historical.version.review' : 'historical.version.approve', 'historical_version', id, before,
        { ...after, review_scope: 'internal_only', government_acceptance: 'not_implied' });
      return withProvenance(after);
    });
  }

  // ------------------------------------------------------------- comparison

  /** Read-only comparison of a version with its basis (or, for a reconstruction without one, with an explicit `against` version of the same
   *  period and statement). Differences are computed by PostgreSQL in NUMERIC; nothing is written. */
  async compare(a: HistoricalActor, id: string, against?: string) {
    this.need(a, 'historical.view');
    if (against !== undefined && !UUID.test(against)) throw bad('HISTORICAL_INPUT_INVALID', 'against is invalid');
    const cols = VERSION_COLS;
    const version = (await this.pool.query(`SELECT ${cols} FROM historical_statement_versions WHERE id = $1 AND company_id = $2`, [id, a.companyId])).rows[0];
    if (!version) throw notFound('Version');
    const baseId = against ?? version.basis_version_id;
    if (!baseId) throw new HistoricalError('HISTORICAL_NO_BASIS', 'This version has no basis; pass an `against` version', 422);
    const basis = (await this.pool.query(`SELECT ${cols} FROM historical_statement_versions WHERE id = $1 AND company_id = $2`, [baseId, a.companyId])).rows[0];
    if (!basis) throw notFound('Basis version');
    if (basis.id === version.id || basis.period_id !== version.period_id || basis.statement_type !== version.statement_type) {
      throw new HistoricalError('HISTORICAL_COMPARISON_INVALID', 'Only versions of the same period and statement can be compared', 422);
    }
    const rows = (await this.pool.query(
      `SELECT COALESCE(v.line_code, b.line_code) AS line_code,
              COALESCE(v.label_ar, b.label_ar) AS label_ar, COALESCE(v.label_en, b.label_en) AS label_en,
              b.amount::text AS basis_amount, v.amount::text AS version_amount,
              (COALESCE(v.amount, 0) - COALESCE(b.amount, 0))::text AS difference,
              CASE WHEN b.line_code IS NULL THEN 'only_in_version' WHEN v.line_code IS NULL THEN 'only_in_basis'
                   WHEN v.amount = b.amount THEN 'match' ELSE 'changed' END AS status
         FROM (SELECT * FROM historical_statement_lines WHERE version_id = $1 AND company_id = $3) v
         FULL OUTER JOIN (SELECT * FROM historical_statement_lines WHERE version_id = $2 AND company_id = $3) b ON b.line_code = v.line_code
        ORDER BY COALESCE(v.line_no, b.line_no + 100000), COALESCE(v.line_code, b.line_code)`, [id, baseId, a.companyId])).rows;
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    const total = (await this.pool.query(
      `SELECT (COALESCE((SELECT SUM(amount) FROM historical_statement_lines WHERE version_id = $1 AND company_id = $3), 0)
             - COALESCE((SELECT SUM(amount) FROM historical_statement_lines WHERE version_id = $2 AND company_id = $3), 0))::text AS d`, [id, baseId, a.companyId])).rows[0].d;
    const describe = (v: typeof version) => ({
      id: v.id, version_no: v.version_no, state: v.state, kind: v.kind, provenance: provenanceOf(v), proof_level: v.proof_level, internal_purpose: v.internal_purpose,
      source_type: v.source_type, confidence: v.confidence, evidence_reference: v.evidence_reference, review_status: v.review_status, fingerprint: v.fingerprint,
    });
    return {
      version: describe(version), basis: describe(basis), basis_source: against ? 'requested' : 'declared_basis',
      lines: rows,
      summary: { matching: count('match'), changed: count('changed'), only_in_basis: count('only_in_basis'), only_in_version: count('only_in_version'), net_difference: total },
      read_only: true, accounting_effect: 'none',
    };
  }
}
