import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { CompanyRepository } from '../src/modules/companies/company.repository';
import type { Company } from '../src/modules/companies/company.types';

// ─── fixtures ────────────────────────────────────────────────────────────────

const COMPANY_A_ID = '00000000-0000-0000-0000-aaaaaaaaaaaa';
const COMPANY_B_ID = '00000000-0000-0000-0000-bbbbbbbbbbbb';

function makeCompany(id: string, slug: string): Company {
  return {
    id,
    slug,
    name: `Company ${slug}`,
    name_ar: null,
    is_active: true,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
  };
}

function makeMockPool(row: Company | null): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }),
  } as unknown as Pool;
}

// ─── tenancy isolation tests ──────────────────────────────────────────────────

describe('CompanyRepository — tenancy isolation', () => {
  let companyA: Company;
  let companyB: Company;

  beforeEach(() => {
    companyA = makeCompany(COMPANY_A_ID, 'alpha');
    companyB = makeCompany(COMPANY_B_ID, 'beta');
  });

  it('findForTenant: returns company when id matches authenticated tenant', async () => {
    const pool = makeMockPool(companyA);
    const repo = new CompanyRepository(pool);

    const result = await repo.findForTenant(COMPANY_A_ID, COMPANY_A_ID);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(COMPANY_A_ID);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('findForTenant: blocks cross-company read and makes NO DB call', async () => {
    // Pool has Company A data — but the tenant is Company B
    const pool = makeMockPool(companyA);
    const repo = new CompanyRepository(pool);

    const result = await repo.findForTenant(COMPANY_A_ID, COMPANY_B_ID);

    expect(result).toBeNull();
    // Critical: DB must not be queried at all when IDs differ
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('findForTenant: Company B tenant cannot access Company A data', async () => {
    const pool = makeMockPool(companyA);
    const repo = new CompanyRepository(pool);

    const result = await repo.findForTenant(COMPANY_A_ID, COMPANY_B_ID);

    expect(result).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('findForTenant: Company A tenant cannot access Company B data', async () => {
    const pool = makeMockPool(companyB);
    const repo = new CompanyRepository(pool);

    const result = await repo.findForTenant(COMPANY_B_ID, COMPANY_A_ID);

    expect(result).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('findForTenant: blocked access resolves to null, never throws', async () => {
    const pool = makeMockPool(null);
    const repo = new CompanyRepository(pool);

    await expect(
      repo.findForTenant(COMPANY_A_ID, COMPANY_B_ID),
    ).resolves.toBeNull();
  });

  it('findForTenant: empty-string tenant ID cannot access any company', async () => {
    const pool = makeMockPool(companyA);
    const repo = new CompanyRepository(pool);

    const result = await repo.findForTenant(COMPANY_A_ID, '');

    expect(result).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('findForTenant: same-company access works for Company B as tenant', async () => {
    const pool = makeMockPool(companyB);
    const repo = new CompanyRepository(pool);

    const result = await repo.findForTenant(COMPANY_B_ID, COMPANY_B_ID);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(COMPANY_B_ID);
  });
});

// ─── smoke: existing health tests still compile (no regressions) ──────────────
describe('CompanyRepository — internal lookups', () => {
  it('_findById: queries DB with the provided id', async () => {
    const companyA = makeCompany(COMPANY_A_ID, 'alpha');
    const pool = makeMockPool(companyA);
    const repo = new CompanyRepository(pool);

    const result = await repo._findById(COMPANY_A_ID);

    expect(result?.id).toBe(COMPANY_A_ID);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = $1'),
      [COMPANY_A_ID],
    );
  });
});
