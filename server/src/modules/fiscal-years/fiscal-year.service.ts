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
 * Orchestrates fiscal-year lifecycle operations with two invariants:
 *
 *  1. Every mutating operation and its audit log entry are written in the
 *     same database transaction — atomically. A rollback removes both.
 *
 *  2. The company context used for capability / overlap checks is always
 *     derived from the fiscal year row fetched from the DB, never from a
 *     caller-supplied value that could name a different company.
 *
 * Sensitive data (passwords, hashes, secrets) is never written to audit_log.
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
   */
  private validateDates(startDate: string, endDate: string): void {
    if (startDate >= endDate) {
      throw new Error(
        `Invalid date range: start_date '${startDate}' must be strictly before end_date '${endDate}'`,
      );
    }
  }

  /**
   * Reject any date range that overlaps with an existing fiscal year
   * in the same company.
   *
   * @param excludeId  Exclude this fiscal year ID (used during updates so
   *                   the year being edited does not conflict with itself).
   */
  private async checkNoOverlap(
    companyId: string,
    startDate: string,
    endDate: string,
    excludeId?: string,
  ): Promise<void> {
    const overlapping = await this.fyRepo.findOverlapping(
      companyId,
      startDate,
      endDate,
      excludeId,
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
   * Validates date order and absence of overlap within the company before
   * opening a transaction that writes the fiscal year row and its audit entry.
   */
  async createFiscalYear(
    input: CreateFiscalYearInput,
    actorUserId: string,
  ): Promise<FiscalYear> {
    this.validateDates(input.start_date, input.end_date);
    await this.checkNoOverlap(input.company_id, input.start_date, input.end_date);

    return this.withTransaction(async (client) => {
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
   * Closed fiscal years are immutable. Date validation and overlap checks run
   * before the transaction is opened.
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

    // Resolve effective dates for validation (merge input with current values).
    const effectiveStart = input.start_date ?? existing.start_date;
    const effectiveEnd   = input.end_date   ?? existing.end_date;
    this.validateDates(effectiveStart, effectiveEnd);
    // Exclude the fiscal year being updated from its own overlap check.
    await this.checkNoOverlap(companyId, effectiveStart, effectiveEnd, id);

    return this.withTransaction(async (client) => {
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
