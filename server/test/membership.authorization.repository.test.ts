import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

describe('MembershipRepository authorization queries', () => {
  it('derives allowed companies only from active memberships joined to active companies', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const repo = new MembershipRepository({ query } as unknown as Pool);

    await repo.listActiveCompaniesForUser('user-1');

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('m.is_active = TRUE');
    expect(sql).toContain('c.is_active = TRUE');
    expect(query).toHaveBeenCalledWith(expect.any(String), ['user-1']);
  });

  it('requires role.company_id to match membership.company_id when resolving capabilities', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ capability_id: 'report.view', currently_authorized: true, is_system_admin: false, system_admin_policy_version: 0, role_policy_key: null, role_policy_version: 0, role_is_full_access: false }],
      rowCount: 1,
    });
    const repo = new MembershipRepository({ query } as unknown as Pool);

    const result = await repo.getActiveCapabilities('user-1', 'company-a');

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('r.company_id = m.company_id');
    expect(sql).toContain('m.is_active = TRUE');
    expect(sql).toContain('c.is_active = TRUE');
    expect(sql).toContain('CROSS JOIN capabilities cap');
    expect(sql).toContain('FROM role_capabilities rc');
    expect(sql).toContain('rc.capability_id = cap.id');
    expect(result).toEqual(['report.view']);
  });

  it('keeps normal roles on explicit grants while Full Access reads implicit and payroll read capabilities dynamically', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const repo = new MembershipRepository({ query } as unknown as Pool);

    await repo.getActiveCapabilities('user-1', 'company-a');

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toMatch(/CROSS JOIN capabilities cap[\s\S]*FROM role_capabilities rc/);
    expect(sql).toContain('cap.id = ANY($3::text[])');
    expect(query).toHaveBeenCalledWith(expect.any(String), ['user-1', 'company-a', ['payroll.accounting.mapping.view', 'payroll.accounting.preview', 'payroll.settlement.view']]);
    expect(sql).toMatch(/FROM role_capabilities rc[\s\S]*rc\.role_id = r\.id[\s\S]*rc\.capability_id = cap\.id/i);
    expect(sql).not.toMatch(/INSERT INTO role_capabilities/i);
  });

  it('fails closed for disabled membership, inactive company, role mismatch, and another company', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const repo = new MembershipRepository({ query } as unknown as Pool);

    await expect(repo.getActiveCapabilities('user-1', 'company-b')).resolves.toEqual([]);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('c.is_active = TRUE');
    expect(sql).toContain('r.company_id = m.company_id');
    expect(sql).toContain('m.is_active = TRUE');
    expect(sql).toContain('m.company_id = c.id');
    expect(query).toHaveBeenCalledWith(expect.any(String), ['user-1', 'company-b', ['payroll.accounting.mapping.view', 'payroll.accounting.preview', 'payroll.settlement.view']]);
  });

  it('resolves Full Access authority only through active same-company membership state', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ has_full_access: true }], rowCount: 1 });
    const repo = new MembershipRepository({ query } as unknown as Pool);

    await expect(repo.hasActiveFullAccessRole('user-1', 'company-a')).resolves.toBe(true);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('r.company_id = m.company_id');
    expect(sql).toContain('c.is_active = TRUE');
    expect(sql).toContain('m.is_active = TRUE');
    expect(sql).toContain('r.is_full_access = TRUE');
    expect(query).toHaveBeenCalledWith(expect.any(String), ['user-1', 'company-a']);
  });
});
