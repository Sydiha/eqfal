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
      rows: [{ capability_id: 'report.view' }],
      rowCount: 1,
    });
    const repo = new MembershipRepository({ query } as unknown as Pool);

    const result = await repo.getActiveCapabilities('user-1', 'company-a');

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('r.company_id = m.company_id');
    expect(sql).toContain('m.is_active  = TRUE');
    expect(sql).toContain('c.is_active = TRUE');
    expect(sql).toContain('JOIN capabilities cap ON r.is_full_access = TRUE');
    expect(sql).toContain('FROM role_capabilities rc');
    expect(sql).toContain('rc.capability_id = cap.id');
    expect(result).toEqual(['report.view']);
  });

  it('keeps normal roles on explicit role_capabilities while Full Access reads every capability row dynamically', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const repo = new MembershipRepository({ query } as unknown as Pool);

    await repo.getActiveCapabilities('user-1', 'company-a');

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toMatch(/JOIN capabilities cap ON r\.is_full_access = TRUE\s+OR EXISTS/i);
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
    expect(sql).toContain('m.is_active  = TRUE');
    expect(sql).toContain('m.company_id = $2');
    expect(query).toHaveBeenCalledWith(expect.any(String), ['user-1', 'company-b']);
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
