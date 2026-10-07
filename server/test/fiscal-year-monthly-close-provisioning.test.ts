import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectedMonthlyPeriods } from '../src/shared/expected-monthly-periods';
import { expectedMonthlyPeriods as annualClosingExpected } from '../src/modules/annual-closing/annual-closing.service';
import { MonthlyCloseProvisioningService } from '../src/modules/monthly-close/monthly-close.service';
import { FiscalYearService } from '../src/modules/fiscal-years/fiscal-year.service';
import { FiscalYearRepository } from '../src/modules/fiscal-years/fiscal-year.repository';
import { AuditLogRepository } from '../src/modules/audit-log/audit-log.repository';
import { getFiscalYearCloseReadiness, loadFiscalYearBounds } from '../src/modules/fiscal-years/fiscal-year-close-readiness';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Suite 0 (no database): single shared boundary function + provisioner SQL contract
// ---------------------------------------------------------------------------
describe('expectedMonthlyPeriods is a single shared implementation', () => {
  it('annual-closing re-exports the exact shared function (no second copy)', () => {
    expect(annualClosingExpected).toBe(expectedMonthlyPeriods);
  });

  it('calendar year: 12 periods, Feb 2026 ends 2026-02-28 (not a leap year)', () => {
    const periods = expectedMonthlyPeriods('2026-01-01', '2026-12-31');
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ period_start: '2026-01-01', period_end: '2026-01-31' });
    expect(periods[1]).toEqual({ period_start: '2026-02-01', period_end: '2026-02-28' });
    expect(periods[11]).toEqual({ period_start: '2026-12-01', period_end: '2026-12-31' });
  });

  it('leap year 2024: Feb ends 2024-02-29', () => {
    expect(expectedMonthlyPeriods('2024-01-01', '2024-12-31')[1]).toEqual({ period_start: '2024-02-01', period_end: '2024-02-29' });
  });

  it('partial fiscal year truncates first and last month', () => {
    const periods = expectedMonthlyPeriods('2026-01-15', '2026-12-20');
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ period_start: '2026-01-15', period_end: '2026-01-31' });
    expect(periods[11]).toEqual({ period_start: '2026-12-01', period_end: '2026-12-20' });
  });

  it('non-calendar fiscal year (Jul 1 - Jun 30) yields 12 periods', () => {
    const periods = expectedMonthlyPeriods('2025-07-01', '2026-06-30');
    expect(periods).toHaveLength(12);
    expect(periods[0]!.period_start).toBe('2025-07-01');
    expect(periods[11]).toEqual({ period_start: '2026-06-01', period_end: '2026-06-30' });
  });
});

describe('MonthlyCloseProvisioningService (mocked client)', () => {
  const service = new MonthlyCloseProvisioningService();
  const fy = randomUUID();
  const company = randomUUID();

  it('inserts exactly the expected periods as open using the real unique constraint', async () => {
    let n = 0;
    const query = vi.fn(async () => ({ rows: [{ id: `p${++n}` }], rowCount: 1 }));
    const ids = await service.provisionDefaultPeriods(fy, company, '2026-01-01', '2026-12-31', { query } as unknown as PoolClient);
    expect(ids).toHaveLength(12);
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls).toHaveLength(12);
    const expected = expectedMonthlyPeriods('2026-01-01', '2026-12-31');
    calls.forEach(([sql, params], i) => {
      expect(sql).toContain("'open'");
      expect(sql.replace(/\s+/g, ' ')).toContain('ON CONFLICT (company_id, period_start, period_end) DO NOTHING');
      expect(params).toEqual([company, fy, expected[i]!.period_start, expected[i]!.period_end]);
    });
  });

  it('full retry on the same fiscal year creates nothing (createdIds = [])', async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith('INSERT')
      ? { rows: [], rowCount: 0 }
      : { rows: [{ fiscal_year_id: fy }], rowCount: 1 });
    const ids = await service.provisionDefaultPeriods(fy, company, '2026-01-01', '2026-12-31', { query } as unknown as PoolClient);
    expect(ids).toEqual([]);
  });

  it('throws when a month already exists under another fiscal year', async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith('INSERT')
      ? { rows: [], rowCount: 0 }
      : { rows: [{ fiscal_year_id: randomUUID() }], rowCount: 1 });
    await expect(service.provisionDefaultPeriods(fy, company, '2026-01-01', '2026-12-31', { query } as unknown as PoolClient))
      .rejects.toThrow(/another fiscal year/);
  });
});

describe('FiscalYearService.createFiscalYear provisioning failure (mocked)', () => {
  it('rolls back, never commits and writes no audit event when provisioning fails', async () => {
    const executed: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        executed.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
        if (/INSERT INTO monthly_close_periods/.test(sql)) throw new Error('injected provisioning failure');
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client), query: vi.fn() } as unknown as Pool;
    const fyRow = { id: randomUUID(), company_id: randomUUID(), name: 'FY', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open', created_at: new Date(), updated_at: new Date() };
    vi.spyOn(FiscalYearRepository.prototype, 'findOverlapping').mockResolvedValue([]);
    vi.spyOn(FiscalYearRepository.prototype, 'create').mockResolvedValue(fyRow as never);
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue(undefined as never);

    await expect(new FiscalYearService(pool).createFiscalYear(
      { company_id: fyRow.company_id, name: 'FY', start_date: '2026-01-01', end_date: '2026-12-31' }, randomUUID(),
    )).rejects.toThrow('injected provisioning failure');

    expect(executed).toContain('ROLLBACK');
    expect(executed).not.toContain('COMMIT');
    expect(audit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Suites 1 and 3 (real PostgreSQL, migrations applied): run only with DATABASE_URL
// ---------------------------------------------------------------------------
describeDatabase('FY creation auto-provisions monthly periods (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const fyService = new FiscalYearService(pool);
  const companies: string[] = [];
  const userId = randomUUID();

  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'x')", [userId, `fy-prov-${userId}@example.test`]);
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM monthly_close_periods WHERE company_id = ANY($1)', [companies]);
      await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
      await pool.query('DELETE FROM fiscal_years WHERE company_id = ANY($1)', [companies]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
      await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    } catch { /* best-effort cleanup on a disposable test database */ }
    await pool.end();
  });

  async function newCompany(): Promise<string> {
    const id = randomUUID();
    companies.push(id);
    await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'Provisioning')", [id, `prov-${id}`]);
    return id;
  }
  const create = (company: string, start: string, end: string, name = `FY ${start}`) =>
    fyService.createFiscalYear({ company_id: company, name, start_date: start, end_date: end }, userId);
  const periodsOf = async (company: string, fy: string) => (await pool.query<{ id: string; period_start: string; period_end: string; status: string }>(
    'SELECT id,period_start::text,period_end::text,status FROM monthly_close_periods WHERE company_id=$1 AND fiscal_year_id=$2 ORDER BY period_start', [company, fy])).rows;

  for (const [label, start, end] of [
    ['normal Jan-Dec', '2026-01-01', '2026-12-31'],
    ['partial Jan 15 - Dec 20', '2026-01-15', '2026-12-20'],
    ['non-calendar Jul 1 - Jun 30', '2025-07-01', '2026-06-30'],
  ] as const) {
    it(`${label}: provisions exactly expectedMonthlyPeriods(), all open, no duplicates`, async () => {
      const company = await newCompany();
      const fy = await create(company, start, end);
      const actual = await periodsOf(company, fy.id);
      const expected = expectedMonthlyPeriods(start, end);
      expect(actual.map((p) => ({ period_start: p.period_start, period_end: p.period_end }))).toEqual(expected);
      expect(actual.every((p) => p.status === 'open')).toBe(true);
      expect(new Set(actual.map((p) => p.period_start)).size).toBe(actual.length);
    });
  }

  it('provisioning failure rolls back the fiscal year row too (atomic)', async () => {
    const company = await newCompany();
    const failing = {
      connect: async () => {
        const client = await pool.connect();
        const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
          if (typeof args[0] === 'string' && /INSERT INTO monthly_close_periods/.test(args[0])) return Promise.reject(new Error('injected provisioning failure'));
          return original(...args);
        };
        return client;
      },
      query: pool.query.bind(pool),
    } as unknown as Pool;
    await expect(new FiscalYearService(failing).createFiscalYear(
      { company_id: company, name: 'FY Rollback', start_date: '2026-01-01', end_date: '2026-12-31' }, userId,
    )).rejects.toThrow('injected provisioning failure');
    expect((await pool.query('SELECT 1 FROM fiscal_years WHERE company_id=$1', [company])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM monthly_close_periods WHERE company_id=$1', [company])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM audit_log WHERE company_id=$1 AND action='fiscal_year.create'", [company])).rowCount).toBe(0);
  });

  it('full retry of provisioning creates 0 new periods and leaves exactly the expected rows', async () => {
    const company = await newCompany();
    const fy = await create(company, '2026-01-01', '2026-12-31');
    const before = await periodsOf(company, fy.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids = await new MonthlyCloseProvisioningService().provisionDefaultPeriods(fy.id, company, '2026-01-01', '2026-12-31', client);
      await client.query('COMMIT');
      expect(ids).toHaveLength(0);
    } finally { client.release(); }
    expect(await periodsOf(company, fy.id)).toEqual(before);
    expect(before).toHaveLength(12);
  });

  // Suite 3: close readiness behaviour is unchanged (readiness code was not modified).
  describe('fiscal-year close readiness unchanged', () => {
    const blockerCodes = async (company: string, fy: string) => {
      const client = await pool.connect();
      try {
        const readiness = await getFiscalYearCloseReadiness(client, company, await loadFiscalYearBounds(client, company, fy));
        return new Map(readiness.blockers.map((b) => [b.code, b.count]));
      } finally { client.release(); }
    };

    it('blocks missing months', async () => {
      const company = await newCompany();
      const fy = await create(company, '2026-01-01', '2026-12-31');
      await pool.query('DELETE FROM monthly_close_periods WHERE fiscal_year_id=$1 AND period_start=$2', [fy.id, '2026-10-01']);
      expect((await blockerCodes(company, fy.id)).get('monthly_period_missing')).toBe(1);
    });

    it('blocks a fresh year whose 12 provisioned periods are all open', async () => {
      const company = await newCompany();
      const fy = await create(company, '2026-01-01', '2026-12-31');
      const codes = await blockerCodes(company, fy.id);
      expect(codes.get('monthly_period_open')).toBe(12);
      expect(codes.has('monthly_period_missing')).toBe(false);
    });

    it('raises no monthly-period blocker when all 12 periods are closed', async () => {
      const company = await newCompany();
      const fy = await create(company, '2026-01-01', '2026-12-31');
      await pool.query("UPDATE monthly_close_periods SET status='closed' WHERE fiscal_year_id=$1", [fy.id]);
      const codes = await blockerCodes(company, fy.id);
      expect(codes.has('monthly_period_open')).toBe(false);
      expect(codes.has('monthly_period_missing')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 2 (real PostgreSQL): FY 2026 repair migration 060. Uses the fixed production-test
// IDs, so it SKIPS itself if that company already exists. Run only on a disposable database.
// ---------------------------------------------------------------------------
describeDatabase('FY 2026 repair migration 060 (PostgreSQL)', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const COMPANY = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def';
  const FY = 'dcbdd629-6d8d-4ce7-82ab-7192dd3e74dc';
  const sql = readFileSync(new URL('../migrations/060_monthly_close_periods_fy2026_repair.sql', import.meta.url), 'utf8');
  let disposable = false;

  const snapshot = async () => (await pool.query<{ period_start: string; period_end: string; status: string; id: string; updated_at: Date }>(
    'SELECT id,period_start::text,period_end::text,status,updated_at FROM monthly_close_periods WHERE company_id=$1 ORDER BY period_start', [COMPANY])).rows;

  beforeAll(async () => {
    disposable = (await pool.query('SELECT 1 FROM companies WHERE id=$1', [COMPANY])).rowCount === 0;
  });

  afterAll(async () => {
    if (disposable) {
      try {
        await pool.query('DELETE FROM monthly_close_periods WHERE company_id=$1', [COMPANY]);
        await pool.query('DELETE FROM fiscal_years WHERE company_id=$1', [COMPANY]);
        await pool.query('DELETE FROM companies WHERE id=$1', [COMPANY]);
      } catch { /* best-effort cleanup */ }
    }
    await pool.end();
  });

  it('is a no-op when the fiscal year does not exist', async (ctx) => {
    if (!disposable) ctx.skip();
    await pool.query(sql);
    expect((await pool.query('SELECT 1 FROM monthly_close_periods WHERE company_id=$1', [COMPANY])).rowCount).toBe(0);
  });

  it('adds only Oct and Dec as open, preserves existing rows and FY status, and is idempotent', async (ctx) => {
    if (!disposable) ctx.skip();
    await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,'fy2026-repair-test','FY2026 Repair')", [COMPANY]);
    await pool.query("INSERT INTO fiscal_years(id,company_id,name,start_date,end_date,status) VALUES($1,$2,'FY 2026','2026-01-01','2026-12-31','closed')", [FY, COMPANY]);
    const existing = expectedMonthlyPeriods('2026-01-01', '2026-12-31').filter((p) => !['2026-10-01', '2026-12-01'].includes(p.period_start));
    for (const p of existing) {
      await pool.query("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,$3,$4,$5)",
        [COMPANY, FY, p.period_start, p.period_end, p.period_start === '2026-11-01' ? 'open' : 'closed']);
    }
    const before = await snapshot();
    expect(before).toHaveLength(10);

    await pool.query(sql);
    const after = await snapshot();
    expect(after).toHaveLength(12);
    const byStart = new Map(after.map((r) => [r.period_start, r]));
    expect(byStart.get('2026-10-01')).toMatchObject({ period_end: '2026-10-31', status: 'open' });
    expect(byStart.get('2026-12-01')).toMatchObject({ period_end: '2026-12-31', status: 'open' });
    for (const row of before) expect(byStart.get(row.period_start)).toEqual(row); // id, status, updated_at unchanged
    expect(byStart.get('2026-01-01')!.status).toBe('closed');
    expect(byStart.get('2026-09-01')!.status).toBe('closed');
    expect(byStart.get('2026-11-01')!.status).toBe('open');
    expect((await pool.query('SELECT status FROM fiscal_years WHERE id=$1', [FY])).rows[0]!.status).toBe('closed');

    await pool.query(sql); // second run: identical result
    expect(await snapshot()).toEqual(after);
  });
});
