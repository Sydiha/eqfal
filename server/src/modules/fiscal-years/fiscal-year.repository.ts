import { Pool, PoolClient } from 'pg';
import {
  FiscalYear,
  CreateFiscalYearInput,
  UpdateFiscalYearInput,
} from './fiscal-year.types';

type QueryRunner = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/**
 * FiscalYearRepository
 *
 * Cross-company isolation: every read and write includes company_id in the
 * WHERE clause. There is no method that operates across companies.
 *
 * Transactional writes: create / updateStatus / update accept a QueryRunner
 * (Pool or PoolClient) so the caller can wrap them in a transaction.
 */
export class FiscalYearRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Insert a new fiscal year row.
   * Caller is responsible for date-validity and overlap checks before calling.
   */
  async create(
    input: CreateFiscalYearInput,
    runner: QueryRunner,
  ): Promise<FiscalYear> {
    const { rows } = await runner.query<FiscalYear>(
      `INSERT INTO fiscal_years (company_id, name, start_date, end_date)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.company_id, input.name, input.start_date, input.end_date],
    );
    return rows[0]!;
  }

  /**
   * Look up a single fiscal year by PK, scoped to companyId.
   * Returns null when not found or when the company does not match —
   * the caller cannot distinguish these cases intentionally.
   */
  async findById(id: string, companyId: string): Promise<FiscalYear | null> {
    const { rows } = await this.pool.query<FiscalYear>(
      `SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2`,
      [id, companyId],
    );
    return rows[0] ?? null;
  }

  /**
   * Lock-and-read: SELECT … FOR UPDATE scoped to companyId.
   *
   * Acquires a row-level exclusive lock inside the caller's transaction so
   * that any concurrent transaction attempting to read the same row with
   * FOR UPDATE (or write to it) must wait until this transaction commits or
   * rolls back. This guarantees:
   *
   *  · before_data in the audit log reflects the row state at the moment the
   *    mutation begins, not a stale pre-transaction snapshot.
   *  · Two concurrent calls for the same fiscal year cannot both pass the
   *    status guard and both succeed — the second will see the committed
   *    state (e.g. already 'closed') from the first.
   *
   * Must be called with a PoolClient that is already in a BEGIN block.
   */
  async findByIdForUpdate(
    id: string,
    companyId: string,
    client: PoolClient,
  ): Promise<FiscalYear | null> {
    const { rows } = await client.query<FiscalYear>(
      `SELECT * FROM fiscal_years WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [id, companyId],
    );
    return rows[0] ?? null;
  }

  /** Return all fiscal years for a company, ordered chronologically. */
  async findByCompany(companyId: string): Promise<FiscalYear[]> {
    const { rows } = await this.pool.query<FiscalYear>(
      `SELECT id,
              company_id,
              name,
              to_char(start_date, 'YYYY-MM-DD') AS start_date,
              to_char(end_date, 'YYYY-MM-DD') AS end_date,
              status,
              created_at,
              updated_at
         FROM fiscal_years
        WHERE company_id = $1
        ORDER BY fiscal_years.start_date`,
      [companyId],
    );
    return rows;
  }

  /**
   * Find fiscal years within companyId whose date range overlaps [startDate, endDate].
   *
   * start_date and end_date are INCLUSIVE calendar dates (both days belong to
   * the fiscal year), matching every date-range query elsewhere in the system.
   *
   * Overlap formula: existing.start_date <= endDate AND existing.end_date >= startDate
   * Sharing even one day (e.g. one year ends 2026-12-31 and the next starts
   * 2026-12-31) IS an overlap. Truly adjacent years (2026-12-31 then 2027-01-01)
   * do not overlap.
   *
   * @param excludeId  Optional — exclude this fiscal year ID (used during update checks).
   * @param runner     Optional QueryRunner — pass the active PoolClient when calling
   *                   from inside a transaction so the query participates in the same
   *                   connection and sees the correct snapshot. Defaults to the pool
   *                   (auto-commit mode) when omitted.
   */
  async findOverlapping(
    companyId: string,
    startDate: string,
    endDate: string,
    excludeId?: string,
    runner: QueryRunner = this.pool,
  ): Promise<FiscalYear[]> {
    const params: unknown[] = [companyId, startDate, endDate];
    let sql = `
      SELECT * FROM fiscal_years
       WHERE company_id  = $1
         AND start_date  <= $3
         AND end_date    >= $2
    `;
    if (excludeId) {
      params.push(excludeId);
      sql += ` AND id <> $${params.length}`;
    }
    const { rows } = await runner.query<FiscalYear>(sql, params);
    return rows;
  }

  /**
   * Update the status column, scoped to companyId.
   * Returns null when the row is not found or company does not match.
   */
  async updateStatus(
    id: string,
    companyId: string,
    status: string,
    runner: QueryRunner,
  ): Promise<FiscalYear | null> {
    const { rows } = await runner.query<FiscalYear>(
      `UPDATE fiscal_years
          SET status = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3
        RETURNING *`,
      [status, id, companyId],
    );
    return rows[0] ?? null;
  }

  /**
   * Partial update — only supplied fields are written.
   * Scoped to companyId. Returns null when not found.
   */
  async update(
    id: string,
    companyId: string,
    input: UpdateFiscalYearInput,
    runner: QueryRunner,
  ): Promise<FiscalYear | null> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];

    if (input.name !== undefined) {
      params.push(input.name);
      setClauses.push(`name = $${params.length}`);
    }
    if (input.start_date !== undefined) {
      params.push(input.start_date);
      setClauses.push(`start_date = $${params.length}`);
    }
    if (input.end_date !== undefined) {
      params.push(input.end_date);
      setClauses.push(`end_date = $${params.length}`);
    }

    params.push(id);
    const idParam = params.length;
    params.push(companyId);
    const coParam = params.length;

    const { rows } = await runner.query<FiscalYear>(
      `UPDATE fiscal_years
          SET ${setClauses.join(', ')}
        WHERE id = $${idParam} AND company_id = $${coParam}
        RETURNING *`,
      params,
    );
    return rows[0] ?? null;
  }
}
