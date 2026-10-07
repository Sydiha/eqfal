import { Pool, PoolClient } from 'pg';
import logger from '../../shared/logger';
import {
  FiscalYear,
  CreateFiscalYearInput,
  UpdateFiscalYearInput,
} from './fiscal-year.types';
import { FiscalYearConflictError } from './fiscal-year-errors';
import { FiscalYearRepository } from './fiscal-year.repository';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import {
  FiscalYearCloseBlockedError,
  getFiscalYearCloseReadiness,
  loadFiscalYearBounds,
  lockFiscalYearCloseScope,
} from './fiscal-year-close-readiness';

/**
 * FiscalYearService
 *
 * Orchestrates fiscal-year lifecycle operations with four invariants:
 *
 *  1. Every mutating operation and its audit log entry are written in the
 *     same database transaction — atomically. A rollback removes both.
 *
 *  2. The overlap check runs inside the transaction on the same connection,
 *     guarded by a per-company advisory lock acquired before the SELECT.
 *     Eliminates the TOCTOU race on concurrent fiscal-year creation.
 *
 *  3. For closeFiscalYear and updateFiscalYear the pre-update read uses
 *     SELECT … FOR UPDATE (findByIdForUpdate) inside the transaction.
 *     This guarantees:
 *       · before_data in the audit log reflects the row state at the moment
 *         the mutation begins — never a stale pre-transaction snapshot.
 *       · Concurrent calls for the same fiscal year block each other at the
 *         row lock; the second sees the committed state of the first and
 *         cannot silently overwrite or produce a misleading audit entry.
 *
 *  4. Sensitive data (passwords, hashes, secrets) is never written to
 *     audit_log. AuditLogRepository strips known sensitive keys recursively
 *     at the persistence layer as a defence-in-depth measure.
 */
export class FiscalYearService {
  private readonly fyRepo: FiscalYearRepository;
  private readonly auditRepo: AuditLogRepository;

  constructor(private readonly pool: Pool) {
    this.fyRepo = new FiscalYearRepository(pool);
    this.auditRepo = new AuditLogRepository();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Reject invalid date ranges.
   * ISO date strings ('YYYY-MM-DD') compare correctly as strings.
   * Pure — no DB calls.
   */
  private validateDates(startDate: string, endDate: string): void {
    if (startDate >= endDate) {
      throw new Error(
        `Invalid date range: start_date '${startDate}' must be strictly before end_date '${endDate}'`,
      );
    }
  }

  /**
   * Acquire a per-company advisory lock, then check for overlapping fiscal
   * years on the same PoolClient so they share the transaction.
   *
   * pg_advisory_xact_lock(hashtext(company_id)):
   *   · Transaction-scoped — released automatically on COMMIT or ROLLBACK.
   *   · Serialises all callers for the same company_id in PostgreSQL.
   *   · Combined with findByIdForUpdate (FOR UPDATE on the current row),
   *     this eliminates both the date-overlap race and the lost-update race.
   */
  private async lockAndCheckNoOverlap(
    client: PoolClient,
    companyId: string,
    startDate: string,
    endDate: string,
    excludeId?: string,
  ): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [companyId],
    );

    const overlapping = await this.fyRepo.findOverlapping(
      companyId,
      startDate,
      endDate,
      excludeId,
      client,
    );

    if (overlapping.length > 0) {
      const conflict = overlapping[0]!;
      throw new FiscalYearConflictError(
        'FISCAL_YEAR_OVERLAP',
        `Fiscal year overlap: [${startDate}, ${endDate}] conflicts with ` +
        `'${conflict.name}' [${conflict.start_date}, ${conflict.end_date}]`,
      );
    }
  }

  /**
   * Acquire a pool client, run `fn` inside BEGIN/COMMIT, and release.
   * Any error triggers ROLLBACK before re-throwing.
   */
  private async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Public operations ──────────────────────────────────────────────────────

  /**
   * Create a new fiscal year.
   *
   * Date validation is pure (no DB) and runs before the transaction.
   * The advisory lock + overlap check + INSERT + audit entry all execute
   * on the same connection inside one transaction.
   */
  async createFiscalYear(
    input: CreateFiscalYearInput,
    actorUserId: string,
  ): Promise<FiscalYear> {
    this.validateDates(input.start_date, input.end_date);

    return this.withTransaction(async (client) => {
      await this.lockAndCheckNoOverlap(
        client,
        input.company_id,
        input.start_date,
        input.end_date,
      );

      const fy = await this.fyRepo.create(input, client);

      await this.auditRepo.logEvent(
        {
          company_id:    input.company_id,
          actor_user_id: actorUserId,
          action:        'fiscal_year.create',
          entity_type:   'fiscal_year',
          entity_id:     fy.id,
          before_data:   null,
          after_data:    {
            name:       fy.name,
            start_date: fy.start_date,
            end_date:   fy.end_date,
            status:     fy.status,
          },
        },
        client,
      );

      logger.info(
        { fyId: fy.id, companyId: fy.company_id },
        'Fiscal year created',
      );
      return fy;
    });
  }

  /**
   * Close an open fiscal year.
   *
   * Reads the row with SELECT … FOR UPDATE (findByIdForUpdate) inside the
   * transaction so that:
   *   · before_data in the audit log reflects the actual pre-close state.
   *   · A concurrent close for the same fiscal year blocks at the row lock
   *     and, once unblocked, sees status='closed' → throws "already closed".
   * Company scoping is enforced by the WHERE company_id clause in the SELECT.
   */
  async closeFiscalYear(
    id: string,
    companyId: string,
    actorUserId: string,
    reason?: string,
  ): Promise<FiscalYear> {
    return this.withTransaction(async (client) => {
      // Lock the row inside the transaction: authoritative read + row guard.
      const existing = await this.fyRepo.findByIdForUpdate(id, companyId, client);
      if (!existing) {
        throw new Error('Fiscal year not found or access denied');
      }
      if (existing.status === 'closed') {
        throw new FiscalYearConflictError('FISCAL_YEAR_ALREADY_CLOSED', `Fiscal year '${existing.name}' is already closed`);
      }

      // Close gate: serialise against every writer that can create a blocker,
      // then re-check readiness on this same transaction before changing status.
      const bounds = await loadFiscalYearBounds(client, companyId, id);
      await lockFiscalYearCloseScope(client, companyId, bounds);
      const readiness = await getFiscalYearCloseReadiness(client, companyId, bounds);
      if (!readiness.ready) {
        throw new FiscalYearCloseBlockedError(readiness.blockers, readiness.warnings);
      }

      const updated = await this.fyRepo.updateStatus(id, companyId, 'closed', client);
      // Defensive: row vanished between the FOR UPDATE read and the UPDATE
      // (should never happen in practice, but we guard regardless).
      if (!updated) throw new Error('Fiscal year not found or access denied');

      await this.auditRepo.logEvent(
        {
          company_id:    companyId,
          actor_user_id: actorUserId,
          action:        'fiscal_year.status_change',
          entity_type:   'fiscal_year',
          entity_id:     id,
          // before_data comes from the locked row — always accurate.
          before_data:   { status: existing.status },
          after_data:    { status: 'closed' },
          reason:        reason ?? null,
        },
        client,
      );

      logger.info({ fyId: id, companyId }, 'Fiscal year closed');
      return updated;
    });
  }

  /**
   * Update mutable fields (name, start_date, end_date) on an open fiscal year.
   *
   * Reads the row with SELECT … FOR UPDATE inside the transaction so that
   * before_data is always accurate and a concurrent modification cannot
   * silently succeed. The advisory lock + overlap check (excluding this FY)
   * guards against concurrent insertions of overlapping fiscal years.
   */
  async updateFiscalYear(
    id: string,
    companyId: string,
    input: UpdateFiscalYearInput,
    actorUserId: string,
  ): Promise<FiscalYear> {
    return this.withTransaction(async (client) => {
      // Lock the row: authoritative pre-update state + row guard.
      const existing = await this.fyRepo.findByIdForUpdate(id, companyId, client);
      if (!existing) {
        throw new Error('Fiscal year not found or access denied');
      }
      if (existing.status === 'closed') {
        throw new FiscalYearConflictError('FISCAL_YEAR_CLOSED_IMMUTABLE', `Fiscal year '${existing.name}' is closed and cannot be modified`);
      }

      // Resolve effective dates from the locked row, then validate (pure).
      const effectiveStart = input.start_date ?? existing.start_date;
      const effectiveEnd   = input.end_date   ?? existing.end_date;
      this.validateDates(effectiveStart, effectiveEnd);

      // Advisory lock + overlap check on the same client.
      await this.lockAndCheckNoOverlap(
        client,
        companyId,
        effectiveStart,
        effectiveEnd,
        id,
      );

      const updated = await this.fyRepo.update(id, companyId, input, client);
      if (!updated) throw new Error('Fiscal year not found or access denied');

      await this.auditRepo.logEvent(
        {
          company_id:    companyId,
          actor_user_id: actorUserId,
          action:        'fiscal_year.update',
          entity_type:   'fiscal_year',
          entity_id:     id,
          // before_data from the locked row — always reflects actual pre-update state.
          before_data:   {
            name:       existing.name,
            start_date: existing.start_date,
            end_date:   existing.end_date,
            status:     existing.status,
          },
          after_data:    {
            name:       updated.name,
            start_date: updated.start_date,
            end_date:   updated.end_date,
            status:     updated.status,
          },
        },
        client,
      );

      logger.info({ fyId: id, companyId }, 'Fiscal year updated');
      return updated;
    });
  }
}
