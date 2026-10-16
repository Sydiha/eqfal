import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { lockAccountingDate, lockAccountingRange } from '../monthly-close/accounting-period.guard';
import {
  LEDGER_SOURCE_AUTHORITY_BLOCKED_CODE,
  LedgerSourceAuthorityBlockedError,
  ONBOARDING_PATH_CUTOVER_ACTIVE_CODE,
} from './journal-posting-errors';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Application guard for ledger source authority (C1B-1). A date inside an ACTIVE `external_reference_only` range cannot receive a
 * posted journal. No row => no restriction. Callers invoke this AFTER the accounting-month lock (assertAccountingDateWritable), so a
 * concurrent range change is strictly ordered with the posting; the guard itself is a single plain SELECT (no lock, no wait).
 * Database triggers (migration 083) enforce the same rule for every other write path.
 */
export async function assertLedgerSourceAuthority(client: Queryable, companyId: string, accountingDate: string): Promise<void> {
  const blocked = await client.query(
    "SELECT 1 FROM ledger_source_authority WHERE company_id=$1 AND status='active' AND $2::date BETWEEN from_date AND to_date LIMIT 1",
    [companyId, accountingDate],
  );
  if (blocked.rowCount) {
    throw new LedgerSourceAuthorityBlockedError(LEDGER_SOURCE_AUTHORITY_BLOCKED_CODE, 'The accounting date is inside a period whose books are kept outside EQFAL');
  }
}

/** Opening-balance path exclusivity: a fiscal year that overlaps an active range follows the cut-over path, so its opening journal cannot be posted. */
export async function assertFiscalYearNotInCutoverPath(client: Queryable, companyId: string, fiscalYearId: string): Promise<void> {
  const year = (await client.query<{ start_date: string }>('SELECT start_date::text FROM fiscal_years WHERE id=$1 AND company_id=$2', [fiscalYearId, companyId])).rows[0];
  if (!year) return; // the caller's fiscal-year guard reports a missing year
  await lockAccountingDate(companyId, year.start_date, client as PoolClient); // already held by the approve flow; reentrant
  const conflict = await client.query(
    `SELECT 1 FROM ledger_source_authority a JOIN fiscal_years f ON f.id=$2 AND f.company_id=$1
     WHERE a.company_id=$1 AND a.status='active' AND a.from_date<=f.end_date AND a.to_date>=f.start_date LIMIT 1`,
    [companyId, fiscalYearId],
  );
  if (conflict.rowCount) {
    throw new LedgerSourceAuthorityBlockedError(ONBOARDING_PATH_CUTOVER_ACTIVE_CODE, 'This fiscal year follows the cut-over path, so its opening balance cannot be approved');
  }
}

export const AUTHORITY_ERROR_CODES = [
  'AUTHORITY_RANGE_INVALID',
  'AUTHORITY_RANGE_OVERLAP',
  'AUTHORITY_RANGE_HAS_JOURNALS',
  'AUTHORITY_RANGE_CLOSED_PERIOD',
  'AUTHORITY_ONBOARDING_PATH_CONFLICT',
  'LEDGER_SOURCE_AUTHORITY_IMMUTABLE',
  'AUTHORITY_DRAFT_FISCAL_YEAR_INVALID',
] as const;

export class LedgerSourceAuthorityError extends Error {
  constructor(public readonly code: string, message?: string) { super(message ?? code); }
}
export class LedgerSourceAuthorityNotFoundError extends Error {}

export type AuthorityRange = {
  id: string; company_id: string; from_date: string; to_date: string; authority: 'external_reference_only'; status: 'draft' | 'active' | 'voided';
  reason: string; created_by: string; created_at: string; voided_by: string | null; voided_at: string | null; void_reason: string | null;
};
const COLUMNS = `id,company_id,from_date::text,to_date::text,authority,status,reason,created_by,created_at,voided_by,voided_at,void_reason`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value: unknown): value is string => typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validReason = (value: unknown): value is string => typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 500;

function translate(error: unknown): never {
  const message = (error as { message?: string } | null)?.message;
  if (message && (AUTHORITY_ERROR_CODES as readonly string[]).includes(message)) throw new LedgerSourceAuthorityError(message);
  throw error;
}

/**
 * Plumbing for authority ranges. C1B-1 exposes ONLY the read path over HTTP; create/void exist so the lock order and the database triggers
 * are exercised by tests and are ready for C1B-2 (which adds the approved cut-over workflow). Nothing in C1B-1 calls create/void in production.
 *
 * Lock order (identical to posting and fiscal-year close: fiscal year, then months ascending):
 *   company authority advisory lock -> overlapping fiscal years FOR SHARE (by start_date) -> accounting-month locks ascending -> checks -> write.
 * The company lock is used only by authority writers, so no other path can wait on it.
 */
export class LedgerSourceAuthorityService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  async list(companyId: string): Promise<AuthorityRange[]> {
    return (await this.db.query<AuthorityRange>(`SELECT ${COLUMNS} FROM ledger_source_authority WHERE company_id=$1 ORDER BY from_date, created_at, id`, [companyId])).rows;
  }

  private async lockScope(client: PoolClient, companyId: string, from: string, to: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`source-authority:${companyId}`]);
    await client.query(
      'SELECT id FROM fiscal_years WHERE company_id=$1 AND start_date<=$3::date AND end_date>=$2::date ORDER BY start_date FOR SHARE',
      [companyId, from, to],
    );
    await lockAccountingRange(companyId, from, to, client);
  }

  /**
   * INTERNAL, NOT EXPOSED: creates an ACTIVE range. No route calls it (a contract test enforces that), so no HTTP caller can activate authority.
   * Closing the remaining raw path (this method and direct SQL still pass the 083 triggers) needs the accounting design for the cut-over
   * journal and activation (C1B-3); until then it is kept only for backward compatibility with the C1B-1 tests.
   */
  async create(companyId: string, actor: string, input: { fromDate: unknown; toDate: unknown; reason: unknown }): Promise<AuthorityRange> {
    if (!validDate(input.fromDate) || !validDate(input.toDate) || input.fromDate > input.toDate || !validReason(input.reason)) {
      throw new LedgerSourceAuthorityError('AUTHORITY_RANGE_INVALID');
    }
    const { fromDate, toDate } = input;
    const reason = input.reason.trim();
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await this.lockScope(client, companyId, fromDate, toDate);
      const row = (await client.query<AuthorityRange>(
        `INSERT INTO ledger_source_authority(company_id,from_date,to_date,authority,reason,created_by) VALUES($1,$2,$3,'external_reference_only',$4,$5) RETURNING ${COLUMNS}`,
        [companyId, fromDate, toDate, reason, actor],
      )).rows[0]!;
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'ledger_source_authority.create', entity_type: 'ledger_source_authority', entity_id: row.id,
        before_data: null, after_data: { from_date: row.from_date, to_date: row.to_date, authority: row.authority, status: row.status }, reason,
      }, client);
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return translate(error);
    } finally {
      client.release();
    }
  }

  /**
   * C1B-2: records the intent to follow the cut-over path. A draft has NO accounting effect (every guard reads status='active' only) and cannot be
   * activated here. It must start on a fiscal year's first day and end before that year's last day (the native period begins the day after).
   * Lock order matches create(): company authority lock -> fiscal years FOR SHARE -> month locks are NOT needed (a draft blocks nothing).
   */
  async createDraft(companyId: string, actor: string, input: { fromDate: unknown; toDate: unknown; reason: unknown }): Promise<AuthorityRange> {
    if (!validDate(input.fromDate) || !validDate(input.toDate) || input.fromDate > input.toDate || !validReason(input.reason)) {
      throw new LedgerSourceAuthorityError('AUTHORITY_RANGE_INVALID');
    }
    const { fromDate, toDate } = input;
    const reason = input.reason.trim();
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`source-authority:${companyId}`]);
      const year = (await client.query<{ id: string; status: string; end_date: string }>(
        'SELECT id,status,end_date::text FROM fiscal_years WHERE company_id=$1 AND start_date=$2::date FOR SHARE', [companyId, fromDate],
      )).rows[0];
      if (!year || year.status === 'closed' || toDate >= year.end_date) throw new LedgerSourceAuthorityError('AUTHORITY_DRAFT_FISCAL_YEAR_INVALID');
      const opening = await client.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM journal_entries WHERE company_id=$1 AND fiscal_year_id=$2 AND entry_type='opening_balance')
            OR EXISTS (SELECT 1 FROM opening_balance_reviews WHERE company_id=$1 AND fiscal_year_id=$2)
            OR EXISTS (SELECT 1 FROM fiscal_year_carryforwards WHERE company_id=$1 AND to_fiscal_year_id=$2)`, [companyId, year.id],
      );
      if (opening.rowCount) throw new LedgerSourceAuthorityError('AUTHORITY_ONBOARDING_PATH_CONFLICT');
      const row = (await client.query<AuthorityRange>(
        `INSERT INTO ledger_source_authority(company_id,from_date,to_date,authority,status,reason,created_by) VALUES($1,$2,$3,'external_reference_only','draft',$4,$5) RETURNING ${COLUMNS}`,
        [companyId, fromDate, toDate, reason, actor],
      )).rows[0]!;
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'ledger_source_authority.draft_create', entity_type: 'ledger_source_authority', entity_id: row.id,
        before_data: null, after_data: { from_date: row.from_date, to_date: row.to_date, authority: row.authority, status: row.status, fiscal_year_id: year.id }, reason,
      }, client);
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return translate(error);
    } finally {
      client.release();
    }
  }

  async voidDraft(companyId: string, actor: string, id: string, reason: unknown): Promise<AuthorityRange> {
    if (!validReason(reason)) throw new LedgerSourceAuthorityError('AUTHORITY_RANGE_INVALID');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`source-authority:${companyId}`]);
      const row = (await client.query<AuthorityRange>(
        `UPDATE ledger_source_authority SET status='voided',voided_by=$3,voided_at=NOW(),void_reason=$4 WHERE id=$1 AND company_id=$2 AND status='draft' RETURNING ${COLUMNS}`,
        [id, companyId, actor, reason.trim()],
      )).rows[0];
      if (!row) {
        const exists = (await client.query('SELECT 1 FROM ledger_source_authority WHERE id=$1 AND company_id=$2', [id, companyId])).rowCount;
        if (!exists) throw new LedgerSourceAuthorityNotFoundError();
        throw new LedgerSourceAuthorityError('LEDGER_SOURCE_AUTHORITY_IMMUTABLE', 'Only a draft can be voided here');
      }
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'ledger_source_authority.draft_void', entity_type: 'ledger_source_authority', entity_id: id,
        before_data: { status: 'draft' }, after_data: { status: 'voided' }, reason: reason.trim(),
      }, client);
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return translate(error);
    } finally {
      client.release();
    }
  }

  async void(companyId: string, actor: string, id: string, reason: unknown): Promise<AuthorityRange> {
    if (!validReason(reason)) throw new LedgerSourceAuthorityError('AUTHORITY_RANGE_INVALID');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const current = (await client.query<{ from_date: string; to_date: string }>('SELECT from_date::text,to_date::text FROM ledger_source_authority WHERE id=$1 AND company_id=$2', [id, companyId])).rows[0];
      if (!current) throw new LedgerSourceAuthorityNotFoundError();
      await this.lockScope(client, companyId, current.from_date, current.to_date);
      const row = (await client.query<AuthorityRange>(
        `UPDATE ledger_source_authority SET status='voided',voided_by=$3,voided_at=NOW(),void_reason=$4 WHERE id=$1 AND company_id=$2 AND status='active' RETURNING ${COLUMNS}`,
        [id, companyId, actor, reason.trim()],
      )).rows[0];
      if (!row) throw new LedgerSourceAuthorityError('LEDGER_SOURCE_AUTHORITY_IMMUTABLE', 'Range is already voided');
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'ledger_source_authority.void', entity_type: 'ledger_source_authority', entity_id: id,
        before_data: { status: 'active' }, after_data: { status: 'voided' }, reason: reason.trim(),
      }, client);
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return translate(error);
    } finally {
      client.release();
    }
  }
}
