import { Pool, PoolClient } from 'pg';
import logger from '../../shared/logger';
import {
  FiscalYear,
  CreateFiscalYearInput,
  UpdateFiscalYearInput,
} from './fiscal-year.types';
import { FiscalYearRepository } from './fiscal-year.repository';
import { AuditLogRepository } from '../audit-log/audit-log.repository';

/**
 * FiscalYearService
 *
 * Orchestrates fiscal-year lifecycle operations with three invariants:
 *
 *  1. Every mutating operation and its audit log entry are written in the
 *     same database transaction — atomically. A rollback removes both.
 *
 *  2. The overlap check runs inside the transaction on the same connection,
 *     guarded by a per-company advisory lock acquired before the SELECT.
 *     This prevents two concurrent requests from both passing the overlap
 *     check and then both inserting overlapping fiscal years (TOCTOU race).
 *
 *  3. Sensitive data (passwords, hashes, secrets) is never written to
 *     audit_log. AuditLogRepository strips known sensitive keys as a
 *     defence-in-depth measure at the persistence layer.
 *
 * Race-condition protection detail:
 *   pg_advisory_xact_lock(hashtext(company_id)) serialises all fiscal-year
 *   mutations for the same company within PostgreSQL. The lock is transaction-
 *   scoped and released automatically on COMMIT or ROLLBACK. No new extensions
 *   or external services are required.
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
   * Pure — no DB calls. Safe to call before opening a transaction.
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
   * years — both on the same PoolClient so they share the transaction.
   *
   * Advisory lock: pg_advisory_xact_lock(hashtext(company_id))
   *   · Transaction-scoped — released automatically on COMMIT or ROLLBACK.
   *   · Serialises all callers for the same company_id in PostgreSQL.
   *   · Guarantees that the SELECT overlap check and the subsequent INSERT
   *     are atomic with respect to other concurrent requests for the same
   *     company — eliminating the TOCTOU race.
   *
   * @param excludeId  Exclude this ID from the overlap check (update path).
   */
  private async lockAndCheckNoOverlap(
    client: PoolClient,
    companyId: string,
    startDate: string,
    endDate: string,
    excludeId?: string,
  ): Promise<void> {
    // Acquire transaction-scoped advisory lock keyed by company.
    // hashtext returns int4; pg_advisory_xact_lock accepts int4 implicitly.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [companyId],
    );

    // Overlap query runs on the same client (same transaction snapshot).
    const overlapping = await this.fyRepo.findOverlapping(
      companyId,
      startDate,
      endDate,
      excludeId,
      client,
    );

    if (overlapping.length > 0) {
      const conflict = overlapping[0]!;
      throw new Error(
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
   * Date validation runs before the transaction (pure check, no DB).
   * The advisory lock + overlap check + INSERT + audit entry all execute
   * on the same connection inside one transaction — atomically and safely
   * under concurrent load.
   */
  async createFiscalYear(
    input: CreateFiscalYearInput,
    actorUserId: string,
  ): Promise<FiscalYear> {
    // Pure validation — no DB, no transaction needed.
    this.validateDates(input.start_date, input.end_date);

    return this.withTransaction(async (client) => {
      // Lock + overlap check inside the transaction on the same connection.
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
   * The fiscal year is looked up with company_id as a guard — a caller
   * supplying a mismatched companyId gets "not found or access denied".
   * No overlap check is required (closing does not alter date ranges).
   */
  async closeFiscalYear(
    id: string,
    companyId: string,
    actorUserId: string,
    reason?: string,
  ): Promise<FiscalYear> {
    const existing = await this.fyRepo.findById(id, companyId);
    if (!existing) {
      throw new Error('Fiscal year not found or access denied');
    }
    if (existing.status === 'closed') {
      throw new Error(`Fiscal year '${existing.name}' is already closed`);
    }

    return this.withTransaction(async (client) => {
      const updated = await this.fyRepo.updateStatus(id, companyId, 'closed', client);
      // Guard: row disappeared between the pre-check and the update (race).
      if (!updated) throw new Error('Fiscal year not found or access denied');

      await this.auditRepo.logEvent(
        {
          company_id:    companyId,
          actor_user_id: actorUserId,
          action:        'fiscal_year.status_change',
          entity_type:   'fiscal_year',
          entity_id:     id,
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
   * Closed fiscal years are immutable. Date validation runs before the
   * transaction (pure). The advisory lock + overlap check (excluding the
   * fiscal year being edited) + UPDATE + audit entry all run inside one
   * transaction on the same connection.
   */
  async updateFiscalYear(
    id: string,
    companyId: string,
    input: UpdateFiscalYearInput,
    actorUserId: string,
  ): Promise<FiscalYear> {
    const existing = await this.fyRepo.findById(id, companyId);
    if (!existing) {
      throw new Error('Fiscal year not found or access denied');
    }
    if (existing.status === 'closed') {
      throw new Error(`Fiscal year '${existing.name}' is closed and cannot be modified`);
    }

    // Resolve effective dates and validate before opening the transaction.
    const effectiveStart = input.start_date ?? existing.start_date;
    const effectiveEnd   = input.end_date   ?? existing.end_date;
    this.validateDates(effectiveStart, effectiveEnd);

    return this.withTransaction(async (client) => {
      // Lock + overlap check (exclude this FY from its own check) inside tx.
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
