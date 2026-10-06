import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FiscalYearRepository } from '../src/modules/fiscal-years/fiscal-year.repository';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

// Real PostgreSQL: fiscal-year start/end dates are inclusive. Requires
// DATABASE_URL with migrations applied.
describeDatabase('Fiscal-year overlap (inclusive dates) with PostgreSQL', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const repo = new FiscalYearRepository(pool);
  const companyA = randomUUID(), companyB = randomUUID();
  let existingId = '';

  beforeAll(async () => {
    for (const c of [companyA, companyB]) {
      await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'FY Overlap')", [c, `fy-overlap-${c}`]);
    }
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY 2026','2026-01-01','2026-12-31') RETURNING id",
      [companyA],
    );
    existingId = rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[companyA, companyB]]);
    await pool.end();
  });

  const overlaps = async (start: string, end: string, company = companyA, exclude?: string) =>
    (await repo.findOverlapping(company, start, end, exclude)).length;

  it('rejects same-day boundary overlap (end of existing = start of new)', async () => {
    expect(await overlaps('2026-12-31', '2027-12-30')).toBe(1);
  });

  it('rejects same-day boundary overlap (start of existing = end of new)', async () => {
    expect(await overlaps('2025-01-01', '2026-01-01')).toBe(1);
  });

  it('rejects full overlap (identical, contained, containing)', async () => {
    expect(await overlaps('2026-01-01', '2026-12-31')).toBe(1);
    expect(await overlaps('2026-03-01', '2026-04-01')).toBe(1);
    expect(await overlaps('2025-01-01', '2027-12-31')).toBe(1);
  });

  it('rejects partial overlap', async () => {
    expect(await overlaps('2026-06-01', '2027-05-31')).toBe(1);
    expect(await overlaps('2025-06-01', '2026-05-31')).toBe(1);
  });

  it('allows truly adjacent years', async () => {
    expect(await overlaps('2027-01-01', '2027-12-31')).toBe(0);
    expect(await overlaps('2025-01-01', '2025-12-31')).toBe(0);
  });

  it('keeps cross-company isolation', async () => {
    expect(await overlaps('2026-01-01', '2026-12-31', companyB)).toBe(0);
  });

  it('excludes the fiscal year itself on update', async () => {
    expect(await overlaps('2026-01-01', '2026-12-31', companyA, existingId)).toBe(0);
  });
});
