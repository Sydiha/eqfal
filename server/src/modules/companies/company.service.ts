import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';

export interface ManagedCompany {
  id: string;
  slug: string;
  name: string;
  name_ar: string | null;
  is_active: boolean;
  created_at: Date;
  can_edit: boolean;
  can_toggle: boolean;
}

export class CompanyAccessError extends Error {
  constructor(readonly kind: 'not_found' | 'forbidden' | 'conflict', readonly code?: 'COMPANY_LAST_ACTIVE_CONFLICT') { super(kind); }
}

interface CompanyRow { id: string; slug: string; name: string; name_ar: string | null; is_active: boolean; created_at: Date }

const FULL_ACCESS_ROLE_NAME = 'Full Access';

/**
 * CompanyManagementService
 *
 * Tenancy: every operation is scoped to companies in which the actor holds an ACTIVE
 * membership. Capabilities are resolved per TARGET company from the database (never from
 * request input) and deliberately ignore companies.is_active, so a disabled company can be
 * re-enabled by someone who holds company.status.edit in it. A company the actor has no
 * active membership in is reported as not found. There is no hard delete.
 */
export class CompanyManagementService {
  private readonly audit = new AuditLogRepository();

  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
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

  private async capabilitiesIn(userId: string, companyId: string, runner: Pick<Pool, 'query'> | PoolClient): Promise<string[] | null> {
    const membership = await runner.query<{ role_id: string | null }>(
      'SELECT role_id FROM memberships WHERE user_id = $1 AND company_id = $2 AND is_active = TRUE',
      [userId, companyId],
    );
    if (membership.rows.length === 0) return null;
    const { rows } = await runner.query<{ capability_id: string }>(
      `SELECT cap.id AS capability_id
       FROM memberships m
       JOIN roles r ON r.id = m.role_id AND r.company_id = m.company_id
       JOIN capabilities cap ON r.is_full_access = TRUE
         OR EXISTS (SELECT 1 FROM role_capabilities rc WHERE rc.role_id = r.id AND rc.capability_id = cap.id)
       WHERE m.user_id = $1 AND m.company_id = $2 AND m.is_active = TRUE`,
      [userId, companyId],
    );
    return rows.map((row) => row.capability_id);
  }

  private async requireCapability(userId: string, companyId: string, capability: string, runner: Pick<Pool, 'query'> | PoolClient): Promise<void> {
    const caps = await this.capabilitiesIn(userId, companyId, runner);
    if (caps === null) throw new CompanyAccessError('not_found');
    if (!caps.includes(capability)) throw new CompanyAccessError('forbidden');
  }

  private snapshot(row: CompanyRow): Record<string, unknown> {
    return { slug: row.slug, name: row.name, name_ar: row.name_ar, is_active: row.is_active };
  }

  async listForUser(userId: string): Promise<ManagedCompany[]> {
    const { rows } = await this.pool.query<CompanyRow>(
      `SELECT c.id, c.slug, c.name, c.name_ar, c.is_active, c.created_at
       FROM companies c
       JOIN memberships m ON m.company_id = c.id AND m.user_id = $1 AND m.is_active = TRUE
       ORDER BY c.created_at ASC, c.id ASC`,
      [userId],
    );
    const result: ManagedCompany[] = [];
    for (const row of rows) {
      const caps = (await this.capabilitiesIn(userId, row.id, this.pool)) ?? [];
      result.push({ ...row, can_edit: caps.includes('company.edit'), can_toggle: caps.includes('company.status.edit') });
    }
    return result;
  }

  /** Creates the company, a Full Access role in it, and the actor's membership with that role. */
  async create(input: { slug: string; name: string; name_ar: string | null }, actorUserId: string): Promise<CompanyRow> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<CompanyRow>(
        `INSERT INTO companies (slug, name, name_ar) VALUES ($1, $2, $3)
         RETURNING id, slug, name, name_ar, is_active, created_at`,
        [input.slug, input.name, input.name_ar],
      );
      const company = rows[0] as CompanyRow;
      const role = await client.query<{ id: string }>(
        'INSERT INTO roles (company_id, name, is_full_access) VALUES ($1, $2, TRUE) RETURNING id',
        [company.id, FULL_ACCESS_ROLE_NAME],
      );
      await client.query(
        'INSERT INTO memberships (user_id, company_id, role_id) VALUES ($1, $2, $3)',
        [actorUserId, company.id, role.rows[0]?.id],
      );
      await this.audit.logEvent({ company_id: company.id, actor_user_id: actorUserId, action: 'company.create', entity_type: 'company', entity_id: company.id, before_data: null, after_data: this.snapshot(company) }, client);
      return company;
    });
  }

  async update(id: string, patch: { name?: string; name_ar?: string | null }, actorUserId: string): Promise<CompanyRow> {
    return this.transaction(async (client) => {
      await this.requireCapability(actorUserId, id, 'company.edit', client);
      const before = (await client.query<CompanyRow>('SELECT id, slug, name, name_ar, is_active, created_at FROM companies WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw new CompanyAccessError('not_found');
      const name = patch.name ?? before.name;
      const nameAr = patch.name_ar !== undefined ? patch.name_ar : before.name_ar;
      const { rows } = await client.query<CompanyRow>(
        `UPDATE companies SET name = $2, name_ar = $3, updated_at = NOW() WHERE id = $1
         RETURNING id, slug, name, name_ar, is_active, created_at`,
        [id, name, nameAr],
      );
      const after = rows[0] as CompanyRow;
      await this.audit.logEvent({ company_id: id, actor_user_id: actorUserId, action: 'company.update', entity_type: 'company', entity_id: id, before_data: this.snapshot(before), after_data: this.snapshot(after) }, client);
      return after;
    });
  }

  async setActive(id: string, active: boolean, actorUserId: string): Promise<CompanyRow> {
    return this.transaction(async (client) => {
      await this.requireCapability(actorUserId, id, 'company.status.edit', client);
      const before = (await client.query<CompanyRow>('SELECT id, slug, name, name_ar, is_active, created_at FROM companies WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw new CompanyAccessError('not_found');
      if (!active) {
        // Never let the actor lock themselves out of every company.
        const others = await client.query(
          `SELECT 1 FROM memberships m JOIN companies c ON c.id = m.company_id AND c.is_active = TRUE
           WHERE m.user_id = $1 AND m.is_active = TRUE AND m.company_id <> $2 LIMIT 1`,
          [actorUserId, id],
        );
        if (before.is_active && others.rows.length === 0) throw new CompanyAccessError('conflict', 'COMPANY_LAST_ACTIVE_CONFLICT');
      }
      const { rows } = await client.query<CompanyRow>(
        `UPDATE companies SET is_active = $2, updated_at = NOW() WHERE id = $1
         RETURNING id, slug, name, name_ar, is_active, created_at`,
        [id, active],
      );
      const after = rows[0] as CompanyRow;
      await this.audit.logEvent({ company_id: id, actor_user_id: actorUserId, action: active ? 'company.enable' : 'company.disable', entity_type: 'company', entity_id: id, before_data: this.snapshot(before), after_data: this.snapshot(after) }, client);
      return after;
    });
  }
}
