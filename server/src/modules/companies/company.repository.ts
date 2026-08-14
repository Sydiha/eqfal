import { Pool, PoolClient } from 'pg';
import { Company, CreateCompanyInput } from './company.types';

type QueryRunner = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/**
 * CompanyRepository
 *
 * Tenancy boundary: company data is isolated per company_id.
 * External callers (API layer, services) must use `findForTenant` which
 * enforces that the requested company ID matches the authenticated tenant's
 * company ID before touching the database.
 *
 * Rule: cross-company reads are blocked at the repository level — the DB is
 * never queried when the IDs do not match.
 */
export class CompanyRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Tenant-scoped lookup.
   * Returns the company only when `id === tenantCompanyId`.
   * Returns null — without querying the DB — on any ID mismatch.
   * This is the primary primitive that prevents cross-company access.
   */
  async findForTenant(
    id: string,
    tenantCompanyId: string,
  ): Promise<Company | null> {
    if (id !== tenantCompanyId) {
      return null; // blocked — no DB call made
    }
    return this._findById(id, this.pool);
  }

  /**
   * Internal lookup by PK — not tenant-scoped.
   * Use only in auth flows or internal admin paths where the caller has
   * already established authority (e.g. session bootstrap).
   * Never expose this directly to a public API route.
   */
  async _findById(id: string, runner: QueryRunner = this.pool): Promise<Company | null> {
    const { rows } = await runner.query<Company>(
      'SELECT * FROM companies WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Internal lookup by slug.
   * Same authority contract as _findById.
   */
  async _findBySlug(slug: string): Promise<Company | null> {
    const { rows } = await this.pool.query<Company>(
      'SELECT * FROM companies WHERE slug = $1',
      [slug],
    );
    return rows[0] ?? null;
  }

  /**
   * Create a new company.
   * Accepts an optional PoolClient for use inside a caller-managed transaction.
   */
  async create(
    input: CreateCompanyInput,
    client?: PoolClient,
  ): Promise<Company> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<Company>(
      `INSERT INTO companies (slug, name, name_ar)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.slug, input.name, input.name_ar ?? null],
    );
    // rows[0] is always defined after a successful INSERT RETURNING
    return rows[0] as Company;
  }
}
