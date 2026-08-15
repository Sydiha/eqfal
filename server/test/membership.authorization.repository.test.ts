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
    expect(result).toEqual(['report.view']);
  });
});
