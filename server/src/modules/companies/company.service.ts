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
  constructor(readonly kind: 'not_found' | 'forbidden' | 'conflict') { super(kind); }
}

interface CompanyRow { id: string; slug: string; name: string; name_ar: string | null; is_active: boolean; created_at: Date }

const FULL_ACCESS_ROLE_NAME = 'Full Access';

// Default roles and their capabilities for new companies
interface DefaultRoleDefinition {
  name: string;
  is_full_access: boolean;
  capabilities: string[];
}

const DEFAULT_ROLE_VIEWER_CAPABILITIES = [
  'accounting.view',
  'annual_close.view',
  'annual_close.package.view',
  'asset.view',
  'audit.view',
  'bank.view',
  'company.view',
  'company_accounting_profile.view',
  'custody.view',
  'document.view',
  'fiscal_year.view',
  'monthly_close.view',
  'obligation.view',
  'opening_balance.view',
  'partner.view',
  'periodic_adjustment.view',
  'report.view',
  'tax_workpaper.view',
  'vat.view',
  'wht_review.view',
];

const DEFAULT_ROLE_ACCOUNTANT_CAPABILITIES = [
  ...DEFAULT_ROLE_VIEWER_CAPABILITIES,
  'accounting.journal.create',
  'accounting.journal.edit',
  'accounting.journal.post',
  'asset.create',
  'asset.edit',
  'bank.import',
  'bank.match',
  'bank.reconcile',
  'counterparty.create',
  'counterparty.edit',
  'document.edit',
  'document.upload',
  'obligation.create',
  'obligation.edit',
  'obligation.confirm',
  'obligation.settlement.create',
  'opening_balance.item.create',
  'opening_balance.item.edit',
  'opening_balance.item.delete',
  'partner.create',
  'partner.edit',
  'periodic_adjustment.create',
  'periodic_adjustment.edit',
  'periodic_adjustment.post',
  'periodic_adjustment.submit',
  'vat.review',
];

const DEFAULT_ROLE_FINANCE_MANAGER_CAPABILITIES = [
  ...DEFAULT_ROLE_ACCOUNTANT_CAPABILITIES,
  'accounting.chart.create',
  'accounting.chart.edit',
  'asset.approve',
  'asset.cancel',
  'asset.dispose',
  'asset.estimate_change.approve',
  'asset.estimate_change.create',
  'asset.estimate_change.review',
  'company_accounting_profile.approve',
  'company_accounting_profile.create',
  'company_accounting_profile.edit',
  'company_accounting_profile.review',
  'company_accounting_profile.submit',
  'counterparty.disable',
  'custody.close',
  'custody.manage',
  'document.approve',
  'document.review',
  'document.submit',
  'fiscal_year.close',
  'fiscal_year.create',
  'fiscal_year.edit',
  'monthly_close.close',
  'monthly_close.create',
  'annual_close.package.approve',
  'annual_close.package.create',
  'annual_close.package.handoff',
  'annual_close.package.review',
  'annual_close.package.snapshot.create',
  'obligation.cancel',
  'obligation.settlement.remove',
  'opening_balance.approve',
  'opening_balance.review',
  'opening_balance.submit',
  'partner.disable',
  'periodic_adjustment.approve',
  'periodic_adjustment.review',
  'tax_workpaper.adjust.create',
  'tax_workpaper.adjust.delete',
  'tax_workpaper.adjust.edit',
  'tax_workpaper.approve',
  'tax_workpaper.create',
  'tax_workpaper.edit',
  'tax_workpaper.review',
  'tax_workpaper.submit',
  'vat.close',
  'wht_review.create',
  'wht_review.edit',
  'wht_review.review',
  'wht_review.submit',
];

const DEFAULT_ROLES: DefaultRoleDefinition[] = [
  { name: 'Viewer', is_full_access: false, capabilities: DEFAULT_ROLE_VIEWER_CAPABILITIES },
  { name: 'Accountant', is_full_access: false, capabilities: DEFAULT_ROLE_ACCOUNTANT_CAPABILITIES },
  { name: 'Finance Manager', is_full_access: false, capabilities: DEFAULT_ROLE_FINANCE_MANAGER_CAPABILITIES },
  { name: FULL_ACCESS_ROLE_NAME, is_full_access: true, capabilities: [] },
];

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

  /** Creates the company, provisions all 4 default roles, and assigns creator to Full Access role. */
  async create(input: { slug: string; name: string; name_ar: string | null }, actorUserId: string): Promise<CompanyRow> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<CompanyRow>(
        `INSERT INTO companies (slug, name, name_ar) VALUES ($1, $2, $3)
         RETURNING id, slug, name, name_ar, is_active, created_at`,
        [input.slug, input.name, input.name_ar],
      );
      const company = rows[0] as CompanyRow;

      // Create all 4 default roles
      const roleMap: Record<string, string> = {};
      for (const roleDefn of DEFAULT_ROLES) {
        const roleResult = await client.query<{ id: string }>(
          'INSERT INTO roles (company_id, name, is_full_access) VALUES ($1, $2, $3) RETURNING id',
          [company.id, roleDefn.name, roleDefn.is_full_access],
        );
        const roleId = roleResult.rows[0]?.id;
        if (!roleId) throw new Error(`Failed to create role: ${roleDefn.name}`);
        roleMap[roleDefn.name] = roleId;

        // Insert capabilities for non-full-access roles
        if (!roleDefn.is_full_access && roleDefn.capabilities.length > 0) {
          for (const capabilityId of roleDefn.capabilities) {
            await client.query(
              'INSERT INTO role_capabilities (role_id, capability_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [roleId, capabilityId],
            );
          }
        }
      }

      // Assign creator to Full Access role
      const fullAccessRoleId = roleMap[FULL_ACCESS_ROLE_NAME];
      if (!fullAccessRoleId) throw new Error('Failed to create Full Access role');
      await client.query(
        'INSERT INTO memberships (user_id, company_id, role_id) VALUES ($1, $2, $3)',
        [actorUserId, company.id, fullAccessRoleId],
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
        if (before.is_active && others.rows.length === 0) throw new CompanyAccessError('conflict');
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
