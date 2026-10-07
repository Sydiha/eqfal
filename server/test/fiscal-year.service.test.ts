/**
 * Tests for FiscalYearService + FiscalYearRepository + AuditLogRepository
 *
 * Coverage targets:
 *  · Date validation (invalid range rejected)
 *  · Overlap within same company rejected
 *  · Adjacent years (touching boundaries) allowed
 *  · Same period across different companies allowed
 *  · Cross-company lookup / update denied
 *  · Audit correctness: actor, company, entity, before/after
 *  · No secrets in audit data
 *  · Atomicity: no audit entry without committed change
 *  · Atomicity: no committed change without audit entry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { FiscalYearService } from '../src/modules/fiscal-years/fiscal-year.service';
import { FiscalYearRepository } from '../src/modules/fiscal-years/fiscal-year.repository';
import { AuditLogRepository } from '../src/modules/audit-log/audit-log.repository';
import { FiscalYear } from '../src/modules/fiscal-years/fiscal-year.types';
import * as closeGate from '../src/modules/fiscal-years/fiscal-year-close-readiness';

// The readiness gate has its own PostgreSQL-backed suite; here it is stubbed ready.
vi.mock('../src/modules/fiscal-years/fiscal-year-close-readiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/fiscal-years/fiscal-year-close-readiness')>()),
  loadFiscalYearBounds: vi.fn(async () => ({ id: 'ffffffff-0000-0000-0000-000000000001', start_date: '2024-01-01', end_date: '2024-12-31' })),
  lockFiscalYearCloseScope: vi.fn(async () => undefined),
  getFiscalYearCloseReadiness: vi.fn(async () => ({ ready: true, blockers: [], warnings: [] })),
}));

// ─── Constants ────────────────────────────────────────────────────────────────

const COMPANY_A = '00000000-0000-0000-0000-0000000000a1';
const COMPANY_B = '00000000-0000-0000-0000-0000000000b1';
const USER_1    = 'aaaaaaaa-0000-0000-0000-000000000001';
const FY_ID     = 'ffffffff-0000-0000-0000-000000000001';
const AUDIT_ID  = 'eeeeeeee-0000-0000-0000-000000000001';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeFiscalYear(overrides: Partial<FiscalYear> = {}): FiscalYear {
  return {
    id:         FY_ID,
    company_id: COMPANY_A,
    name:       'FY 2024',
    start_date: '2024-01-01',
    end_date:   '2024-12-31',
    status:     'open',
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Minimal mock PoolClient for transaction tests. */
function makeClient(): PoolClient {
  return {
    query:   vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  } as unknown as PoolClient;
}

/**
 * Pool that supports both non-transactional reads (pool.query) and
 * transaction acquisition (pool.connect → client).
 */
function makePool(client?: PoolClient): Pool {
  return {
    query:   vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(client ?? makeClient()),
  } as unknown as Pool;
}

/** Convenience: build a service and expose its internal repos. */
function makeService(client?: PoolClient) {
  const pool    = makePool(client);
  const service = new FiscalYearService(pool);
  const fyRepo  = (service as unknown as { fyRepo: FiscalYearRepository }).fyRepo;
  const auditRepo = (service as unknown as { auditRepo: AuditLogRepository }).auditRepo;
  return { service, pool, fyRepo, auditRepo };
}

// ─── Date validation ──────────────────────────────────────────────────────────

describe('FiscalYearService — date validation', () => {
  it('rejects when start_date equals end_date', async () => {
    const { service } = makeService();
    await expect(
      service.createFiscalYear(
        { company_id: COMPANY_A, name: 'FY', start_date: '2024-01-01', end_date: '2024-01-01' },
        USER_1,
      ),
    ).rejects.toThrow(/invalid date range/i);
  });

  it('rejects when start_date is after end_date', async () => {
    const { service } = makeService();
    await expect(
      service.createFiscalYear(
        { company_id: COMPANY_A, name: 'FY', start_date: '2024-12-31', end_date: '2024-01-01' },
        USER_1,
      ),
    ).rejects.toThrow(/invalid date range/i);
  });
});

// ─── Overlap detection — same company ─────────────────────────────────────────

describe('FiscalYearService — overlap within same company rejected', () => {
  let service: FiscalYearService;
  let fyRepo: FiscalYearRepository;

  beforeEach(() => {
    ({ service, fyRepo } = makeService());
  });

  it('rejects a range that overlaps in the middle', async () => {
    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([
      makeFiscalYear({ start_date: '2024-01-01', end_date: '2024-12-31' }),
    ]);
    await expect(
      service.createFiscalYear(
        { company_id: COMPANY_A, name: 'FY overlap', start_date: '2024-06-01', end_date: '2025-06-30' },
        USER_1,
      ),
    ).rejects.toThrow(/overlap/i);
  });

  it('rejects a range that contains an existing year', async () => {
    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([
      makeFiscalYear({ start_date: '2024-01-01', end_date: '2024-12-31' }),
    ]);
    await expect(
      service.createFiscalYear(
        { company_id: COMPANY_A, name: 'FY wide', start_date: '2023-01-01', end_date: '2025-12-31' },
        USER_1,
      ),
    ).rejects.toThrow(/overlap/i);
  });

  it('overlap error message names the conflicting fiscal year', async () => {
    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([
      makeFiscalYear({ name: 'FY 2024', start_date: '2024-01-01', end_date: '2024-12-31' }),
    ]);
    await expect(
      service.createFiscalYear(
        { company_id: COMPANY_A, name: 'FY overlap', start_date: '2024-06-01', end_date: '2025-01-01' },
        USER_1,
      ),
    ).rejects.toThrow('FY 2024');
  });

  it('does not reach DB write when overlap check fails', async () => {
    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([makeFiscalYear()]);
    const writeSpy = vi.spyOn(fyRepo, 'create');
    await expect(
      service.createFiscalYear(
        { company_id: COMPANY_A, name: 'FY', start_date: '2024-06-01', end_date: '2025-01-01' },
        USER_1,
      ),
    ).rejects.toThrow();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ─── Adjacent years — allowed ─────────────────────────────────────────────────

describe('FiscalYearService — adjacent years (touching boundaries) allowed', () => {
  it('allows a year that starts exactly where another ends', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    // Existing FY 2023: 2023-01-01 → 2023-12-31
    // New FY 2024 starts 2024-01-01 — no overlap (2023-12-31 is NOT >= 2024-01-01)
    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]); // repo confirms: no overlap
    const newFy = makeFiscalYear({ start_date: '2024-01-01', end_date: '2024-12-31' });
    vi.spyOn(fyRepo, 'create').mockResolvedValue(newFy);
    vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.create', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    const result = await service.createFiscalYear(
      { company_id: COMPANY_A, name: 'FY 2024', start_date: '2024-01-01', end_date: '2024-12-31' },
      USER_1,
    );
    expect(result.start_date).toBe('2024-01-01');
  });

  it('findOverlapping treats start/end as inclusive — same-day boundary counts as overlap', async () => {
    // Existing FY: 2026-01-01..2026-12-31 (inclusive). New: 2026-12-31..2027-12-30.
    // Overlap formula: existing.start <= newEnd AND existing.end >= newStart
    //   2026-12-31 >= 2026-12-31 → TRUE → overlap (2026-12-31 belongs to both).
    const pool = makePool();
    const repo = new FiscalYearRepository(pool);
    const querySpy = pool.query as ReturnType<typeof vi.fn>;
    querySpy.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.findOverlapping(COMPANY_A, '2026-12-31', '2027-12-30');

    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/start_date\s*<=\s*\$3/i);
    expect(sql).toMatch(/end_date\s*>=\s*\$2/i);
    expect(sql).not.toMatch(/start_date\s*<\s*\$3/i);
    expect(sql).not.toMatch(/end_date\s*>\s*\$2/i);
    expect(params[1]).toBe('2026-12-31');
    expect(params[2]).toBe('2027-12-30');
  });

  it('findOverlapping keeps self-exclusion on update', async () => {
    const pool = makePool();
    const repo = new FiscalYearRepository(pool);
    const querySpy = pool.query as ReturnType<typeof vi.fn>;
    querySpy.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.findOverlapping(COMPANY_A, '2026-01-01', '2026-12-31', FY_ID);

    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/id\s*<>\s*\$4/i);
    expect(params[3]).toBe(FY_ID);
  });
});

// ─── Same period, different companies — allowed ───────────────────────────────

describe('FiscalYearService — same period in different companies is allowed', () => {
  it('does not reject when the overlap query returns no rows (scoped to company_id)', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    // Company A already has 2024-01-01 → 2024-12-31.
    // Company B creates the same range — findOverlapping is scoped to COMPANY_B,
    // so it returns [] (different company, no conflict).
    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]);
    const newFy = makeFiscalYear({ company_id: COMPANY_B });
    vi.spyOn(fyRepo, 'create').mockResolvedValue(newFy);
    vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_B, actor_user_id: USER_1,
      action: 'fiscal_year.create', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    const result = await service.createFiscalYear(
      { company_id: COMPANY_B, name: 'FY 2024', start_date: '2024-01-01', end_date: '2024-12-31' },
      USER_1,
    );
    expect(result.company_id).toBe(COMPANY_B);

    // Verify the overlap check was called with COMPANY_B (not COMPANY_A) and the client.
    expect(fyRepo.findOverlapping).toHaveBeenCalledWith(
      COMPANY_B, '2024-01-01', '2024-12-31', undefined, client,
    );
  });
});

// ─── Cross-company lookup denial ──────────────────────────────────────────────

describe('FiscalYearService — cross-company access denied', () => {
  it('closeFiscalYear: returns "not found or access denied" when companyId does not match', async () => {
    const { service, fyRepo } = makeService();
    // findById with COMPANY_B returns null when the FY belongs to COMPANY_A
    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(null);

    await expect(
      service.closeFiscalYear(FY_ID, COMPANY_B, USER_1),
    ).rejects.toThrow(/not found or access denied/i);
  });

  it('updateFiscalYear: returns "not found or access denied" when companyId does not match', async () => {
    const { service, fyRepo } = makeService();
    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(null);

    await expect(
      service.updateFiscalYear(FY_ID, COMPANY_B, { name: 'Renamed' }, USER_1),
    ).rejects.toThrow(/not found or access denied/i);
  });

  it('cross-company denial makes no DB write', async () => {
    const { service, fyRepo } = makeService();
    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(null);
    const writeSpy = vi.spyOn(fyRepo, 'updateStatus');

    await expect(service.closeFiscalYear(FY_ID, COMPANY_B, USER_1)).rejects.toThrow();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('findById always scoped — verifies companyId is passed to repo', async () => {
    const pool = makePool();
    const repo = new FiscalYearRepository(pool);
    const querySpy = pool.query as ReturnType<typeof vi.fn>;
    querySpy.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await repo.findById(FY_ID, COMPANY_B);

    expect(result).toBeNull();
    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/company_id/i);
    expect(params).toContain(COMPANY_B);
  });
});

// ─── Closed fiscal year is immutable ─────────────────────────────────────────

describe('FiscalYearService — closed fiscal year is immutable', () => {
  it('closeFiscalYear: throws when already closed', async () => {
    const { service, fyRepo } = makeService();
    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(makeFiscalYear({ status: 'closed' }));

    await expect(
      service.closeFiscalYear(FY_ID, COMPANY_A, USER_1),
    ).rejects.toMatchObject({ code: 'FISCAL_YEAR_ALREADY_CLOSED' });
  });

  it('updateFiscalYear: throws when fiscal year is closed', async () => {
    const { service, fyRepo } = makeService();
    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(makeFiscalYear({ status: 'closed' }));

    await expect(
      service.updateFiscalYear(FY_ID, COMPANY_A, { name: 'New Name' }, USER_1),
    ).rejects.toMatchObject({ code: 'FISCAL_YEAR_CLOSED_IMMUTABLE' });
  });
});

// ─── Audit correctness ────────────────────────────────────────────────────────

describe('FiscalYearService — audit entry correctness', () => {
  it('createFiscalYear: audit has correct action, company_id, actor_user_id, entity_id', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);
    const fy = makeFiscalYear();

    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]);
    vi.spyOn(fyRepo, 'create').mockResolvedValue(fy);
    const logSpy = vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.create', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.createFiscalYear(
      { company_id: COMPANY_A, name: 'FY 2024', start_date: '2024-01-01', end_date: '2024-12-31' },
      USER_1,
    );

    expect(logSpy).toHaveBeenCalledOnce();
    const [input] = logSpy.mock.calls[0]!;
    expect(input.action).toBe('fiscal_year.create');
    expect(input.company_id).toBe(COMPANY_A);
    expect(input.actor_user_id).toBe(USER_1);
    expect(input.entity_id).toBe(FY_ID);
    expect(input.entity_type).toBe('fiscal_year');
    expect(input.before_data).toBeNull();
  });

  it('createFiscalYear: audit after_data contains name, start_date, end_date, status', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);
    const fy = makeFiscalYear();

    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]);
    vi.spyOn(fyRepo, 'create').mockResolvedValue(fy);
    const logSpy = vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.create', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.createFiscalYear(
      { company_id: COMPANY_A, name: 'FY 2024', start_date: '2024-01-01', end_date: '2024-12-31' },
      USER_1,
    );

    const [input] = logSpy.mock.calls[0]!;
    expect(input.after_data).toMatchObject({
      name: 'FY 2024',
      start_date: '2024-01-01',
      end_date: '2024-12-31',
      status: 'open',
    });
  });

  it('closeFiscalYear: audit has before_data {status:open} and after_data {status:closed}', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);
    const openFy = makeFiscalYear({ status: 'open' });
    const closedFy = makeFiscalYear({ status: 'closed' });

    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(openFy);
    vi.spyOn(fyRepo, 'updateStatus').mockResolvedValue(closedFy);
    const logSpy = vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.status_change', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: { status: 'open' }, after_data: { status: 'closed' },
      reason: null, created_at: new Date(),
    });

    await service.closeFiscalYear(FY_ID, COMPANY_A, USER_1);

    const [input] = logSpy.mock.calls[0]!;
    expect(input.action).toBe('fiscal_year.status_change');
    expect(input.before_data).toEqual({ status: 'open' });
    expect(input.after_data).toEqual({ status: 'closed' });
  });

  it('closeFiscalYear: reason is passed through to audit', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(makeFiscalYear({ status: 'open' }));
    vi.spyOn(fyRepo, 'updateStatus').mockResolvedValue(makeFiscalYear({ status: 'closed' }));
    const logSpy = vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.status_change', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: 'Year-end close', created_at: new Date(),
    });

    await service.closeFiscalYear(FY_ID, COMPANY_A, USER_1, 'Year-end close');

    const [input] = logSpy.mock.calls[0]!;
    expect(input.reason).toBe('Year-end close');
  });

  it('updateFiscalYear: audit before_data reflects old values, after_data reflects new values', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);
    const before = makeFiscalYear({ name: 'Old Name', start_date: '2024-01-01', end_date: '2024-12-31' });
    const after  = makeFiscalYear({ name: 'New Name', start_date: '2024-01-01', end_date: '2024-12-31' });

    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(before);
    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]);
    vi.spyOn(fyRepo, 'update').mockResolvedValue(after);
    const logSpy = vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.update', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.updateFiscalYear(FY_ID, COMPANY_A, { name: 'New Name' }, USER_1);

    const [input] = logSpy.mock.calls[0]!;
    expect(input.before_data).toMatchObject({ name: 'Old Name' });
    expect(input.after_data).toMatchObject({ name: 'New Name' });
  });
});

// ─── No secrets in audit ──────────────────────────────────────────────────────

describe('FiscalYearService — no secrets in audit data', () => {
  it('createFiscalYear: after_data contains no password or hash fields', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);
    const fy = makeFiscalYear();

    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]);
    vi.spyOn(fyRepo, 'create').mockResolvedValue(fy);
    const logSpy = vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.create', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.createFiscalYear(
      { company_id: COMPANY_A, name: 'FY 2024', start_date: '2024-01-01', end_date: '2024-12-31' },
      USER_1,
    );

    const [input] = logSpy.mock.calls[0]!;
    const afterKeys = Object.keys(input.after_data ?? {});
    const forbidden = ['password', 'password_hash', 'hash', 'secret', 'token'];
    for (const key of forbidden) {
      expect(afterKeys).not.toContain(key);
    }
  });

  it('closeFiscalYear: before/after_data contain no sensitive fields', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(makeFiscalYear({ status: 'open' }));
    vi.spyOn(fyRepo, 'updateStatus').mockResolvedValue(makeFiscalYear({ status: 'closed' }));
    const logSpy = vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.status_change', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.closeFiscalYear(FY_ID, COMPANY_A, USER_1);

    const [input] = logSpy.mock.calls[0]!;
    const forbidden = ['password', 'password_hash', 'hash', 'secret', 'token'];
    const allKeys = [
      ...Object.keys(input.before_data ?? {}),
      ...Object.keys(input.after_data ?? {}),
    ];
    for (const key of forbidden) {
      expect(allKeys).not.toContain(key);
    }
  });
});

// ─── Atomicity — no audit without committed change ────────────────────────────

describe('FiscalYearService — atomicity: no audit entry without committed change', () => {
  it('createFiscalYear: ROLLBACK called and logEvent not called when fyRepo.create throws', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]);
    vi.spyOn(fyRepo, 'create').mockRejectedValue(new Error('DB insert failed'));
    const logSpy = vi.spyOn(auditRepo, 'logEvent');

    await expect(
      service.createFiscalYear(
        { company_id: COMPANY_A, name: 'FY 2024', start_date: '2024-01-01', end_date: '2024-12-31' },
        USER_1,
      ),
    ).rejects.toThrow('DB insert failed');

    expect(logSpy).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('closeFiscalYear: ROLLBACK called when fyRepo.updateStatus throws', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(makeFiscalYear({ status: 'open' }));
    vi.spyOn(fyRepo, 'updateStatus').mockRejectedValue(new Error('DB update failed'));
    const logSpy = vi.spyOn(auditRepo, 'logEvent');

    await expect(
      service.closeFiscalYear(FY_ID, COMPANY_A, USER_1),
    ).rejects.toThrow('DB update failed');

    expect(logSpy).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

// ─── Atomicity — no committed change without audit ───────────────────────────

describe('FiscalYearService — atomicity: no committed change without audit entry', () => {
  it('createFiscalYear: ROLLBACK called when auditRepo.logEvent throws', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]);
    vi.spyOn(fyRepo, 'create').mockResolvedValue(makeFiscalYear());
    vi.spyOn(auditRepo, 'logEvent').mockRejectedValue(new Error('audit DB failed'));

    await expect(
      service.createFiscalYear(
        { company_id: COMPANY_A, name: 'FY 2024', start_date: '2024-01-01', end_date: '2024-12-31' },
        USER_1,
      ),
    ).rejects.toThrow('audit DB failed');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('closeFiscalYear: ROLLBACK called when auditRepo.logEvent throws', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(makeFiscalYear({ status: 'open' }));
    vi.spyOn(fyRepo, 'updateStatus').mockResolvedValue(makeFiscalYear({ status: 'closed' }));
    vi.spyOn(auditRepo, 'logEvent').mockRejectedValue(new Error('audit DB failed'));

    await expect(
      service.closeFiscalYear(FY_ID, COMPANY_A, USER_1),
    ).rejects.toThrow('audit DB failed');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});

// ─── Advisory lock — race-condition prevention ────────────────────────────────

describe('FiscalYearService — advisory lock prevents concurrent overlap bypass', () => {
  it('createFiscalYear: pg_advisory_xact_lock is called on the client with company_id', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]);
    vi.spyOn(fyRepo, 'create').mockResolvedValue(makeFiscalYear());
    vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.create', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.createFiscalYear(
      { company_id: COMPANY_A, name: 'FY 2024', start_date: '2024-01-01', end_date: '2024-12-31' },
      USER_1,
    );

    const clientCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
    const lockCall = clientCalls.find(([sql]) => /pg_advisory_xact_lock/.test(sql));
    expect(lockCall).toBeDefined();
    // The lock must be keyed by company_id so concurrent requests for the same
    // company block each other but different companies run in parallel.
    expect(lockCall![1]).toContain(COMPANY_A);
  });

  it('createFiscalYear: advisory lock is acquired inside the transaction, before overlap check', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    // Track call order across the client.query mock and the findOverlapping spy.
    const callOrder: string[] = [];

    (client.query as ReturnType<typeof vi.fn>).mockImplementation(
      (sql: unknown, ..._rest: unknown[]) => {
        if (typeof sql === 'string' && /pg_advisory_xact_lock/.test(sql)) {
          callOrder.push('advisory_lock');
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    );

    vi.spyOn(fyRepo, 'findOverlapping').mockImplementation(async (..._args) => {
      callOrder.push('findOverlapping');
      return [];
    });
    vi.spyOn(fyRepo, 'create').mockResolvedValue(makeFiscalYear());
    vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.create', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.createFiscalYear(
      { company_id: COMPANY_A, name: 'FY 2024', start_date: '2024-01-01', end_date: '2024-12-31' },
      USER_1,
    );

    const lockIdx    = callOrder.indexOf('advisory_lock');
    const overlapIdx = callOrder.indexOf('findOverlapping');
    expect(lockIdx).toBeGreaterThanOrEqual(0);    // lock was acquired
    expect(overlapIdx).toBeGreaterThan(lockIdx);  // overlap checked AFTER the lock
  });

  it('createFiscalYear: overlap rejection inside transaction triggers ROLLBACK', async () => {
    const client = makeClient();
    const { service, fyRepo } = makeService(client);

    // Overlap check (now inside tx) returns a conflict.
    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([makeFiscalYear()]);
    const writeSpy = vi.spyOn(fyRepo, 'create');

    await expect(
      service.createFiscalYear(
        { company_id: COMPANY_A, name: 'FY', start_date: '2024-06-01', end_date: '2025-01-01' },
        USER_1,
      ),
    ).rejects.toThrow(/overlap/i);

    // Transaction was opened → must be rolled back, never committed.
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('updateFiscalYear: advisory lock uses membership.company_id (not a caller-supplied company)', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(makeFiscalYear({ company_id: COMPANY_A }));
    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]);
    vi.spyOn(fyRepo, 'update').mockResolvedValue(
      makeFiscalYear({ name: 'Renamed', company_id: COMPANY_A }),
    );
    vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.update', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.updateFiscalYear(FY_ID, COMPANY_A, { name: 'Renamed' }, USER_1);

    const clientCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
    const lockCall = clientCalls.find(([sql]) => /pg_advisory_xact_lock/.test(sql));
    expect(lockCall).toBeDefined();
    expect(lockCall![1]).toContain(COMPANY_A);
  });
});

// ─── AuditLogRepository — sensitive-field stripping ──────────────────────────

describe('AuditLogRepository — strips sensitive fields before INSERT', () => {
  it('removes password_hash from before_data and token from after_data', async () => {
    // Test the repository directly — not through a service mock.
    const { AuditLogRepository: AuditRepo } = await import(
      '../src/modules/audit-log/audit-log.repository'
    );
    const auditRepo = new AuditRepo();
    const client    = makeClient();

    await auditRepo.logEvent(
      {
        company_id:    COMPANY_A,
        actor_user_id: USER_1,
        action:        'test.action',
        entity_type:   'fiscal_year',
        entity_id:     FY_ID,
        before_data:   { name: 'old', password_hash: 'bcrypt$...', status: 'open' },
        after_data:    { name: 'new', token: 'eyJhbGci...', status: 'closed' },
      },
      client,
    );

    // The INSERT params: $6 = before_data, $7 = after_data
    const insertCall = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as
      [string, unknown[]];
    const beforeData = insertCall[1][5] as Record<string, unknown>;
    const afterData  = insertCall[1][6] as Record<string, unknown>;

    expect(beforeData).not.toHaveProperty('password_hash');
    expect(beforeData).toHaveProperty('name', 'old');
    expect(beforeData).toHaveProperty('status', 'open');

    expect(afterData).not.toHaveProperty('token');
    expect(afterData).toHaveProperty('name', 'new');
    expect(afterData).toHaveProperty('status', 'closed');
  });

  it('strips all keys in SENSITIVE_KEYS regardless of what the caller passes', async () => {
    const { AuditLogRepository: AuditRepo } = await import(
      '../src/modules/audit-log/audit-log.repository'
    );
    const auditRepo = new AuditRepo();
    const client    = makeClient();

    await auditRepo.logEvent(
      {
        company_id:    COMPANY_A,
        actor_user_id: USER_1,
        action:        'test.action',
        entity_type:   'fiscal_year',
        entity_id:     FY_ID,
        before_data:   {
          safe_field:  'keep',
          password:    'p@ss',
          hash:        'abc',
          secret:      'shhh',
          token:       'tok',
          credential:  'cred',
          private_key: 'pk',
          api_key:     'ak',
        },
        after_data: null,
      },
      client,
    );

    const insertCall = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as
      [string, unknown[]];
    const beforeData = insertCall[1][5] as Record<string, unknown>;
    const afterData  = insertCall[1][6];

    expect(beforeData).toEqual({ safe_field: 'keep' });
    expect(afterData).toBeNull();
  });

  it('preserves non-sensitive fields intact after stripping', async () => {
    const { AuditLogRepository: AuditRepo } = await import(
      '../src/modules/audit-log/audit-log.repository'
    );
    const auditRepo = new AuditRepo();
    const client    = makeClient();

    await auditRepo.logEvent(
      {
        company_id:    COMPANY_A,
        actor_user_id: USER_1,
        action:        'fiscal_year.create',
        entity_type:   'fiscal_year',
        entity_id:     FY_ID,
        before_data:   null,
        after_data:    { name: 'FY 2024', start_date: '2024-01-01', end_date: '2024-12-31', status: 'open' },
      },
      client,
    );

    const insertCall = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as
      [string, unknown[]];
    const afterData = insertCall[1][6] as Record<string, unknown>;

    expect(afterData).toEqual({
      name: 'FY 2024',
      start_date: '2024-01-01',
      end_date: '2024-12-31',
      status: 'open',
    });
  });

  it('strips sensitive keys inside a nested object (recursive)', async () => {
    const { AuditLogRepository: AuditRepo } = await import(
      '../src/modules/audit-log/audit-log.repository'
    );
    const auditRepo = new AuditRepo();
    const client    = makeClient();

    await auditRepo.logEvent(
      {
        company_id:    COMPANY_A,
        actor_user_id: USER_1,
        action:        'test.nested',
        entity_type:   'fiscal_year',
        entity_id:     FY_ID,
        before_data:   {
          safe: 'keep',
          user: {
            email:         'a@b.com',    // safe
            password_hash: 'bcrypt$...', // sensitive — must be removed
            role:          'admin',      // safe
          },
        },
        after_data: null,
      },
      client,
    );

    const insertCall = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as
      [string, unknown[]];
    const beforeData = insertCall[1][5] as Record<string, unknown>;

    expect(beforeData).toEqual({
      safe: 'keep',
      user: { email: 'a@b.com', role: 'admin' },
    });
  });

  it('strips sensitive keys inside objects within an array (recursive)', async () => {
    const { AuditLogRepository: AuditRepo } = await import(
      '../src/modules/audit-log/audit-log.repository'
    );
    const auditRepo = new AuditRepo();
    const client    = makeClient();

    await auditRepo.logEvent(
      {
        company_id:    COMPANY_A,
        actor_user_id: USER_1,
        action:        'test.array',
        entity_type:   'fiscal_year',
        entity_id:     FY_ID,
        before_data:   null,
        after_data:    {
          members: [
            { name: 'Alice', token: 'tok-A', active: true },
            { name: 'Bob',   token: 'tok-B', active: false },
          ],
          total: 2,
        },
      },
      client,
    );

    const insertCall = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as
      [string, unknown[]];
    const afterData = insertCall[1][6] as Record<string, unknown>;

    expect(afterData).toEqual({
      members: [
        { name: 'Alice', active: true },
        { name: 'Bob',   active: false },
      ],
      total: 2,
    });
  });
});

// ─── SELECT FOR UPDATE — lost-update & stale audit prevention ────────────────

describe('FiscalYearService — findByIdForUpdate inside transaction', () => {
  it('closeFiscalYear: findByIdForUpdate is called on the client (inside transaction)', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    const forUpdateSpy = vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(
      makeFiscalYear({ status: 'open' }),
    );
    vi.spyOn(fyRepo, 'updateStatus').mockResolvedValue(makeFiscalYear({ status: 'closed' }));
    vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.status_change', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.closeFiscalYear(FY_ID, COMPANY_A, USER_1);

    // Must have been called with the pooled client — confirms it runs inside withTransaction.
    expect(forUpdateSpy).toHaveBeenCalledWith(FY_ID, COMPANY_A, client);
  });

  it('closeFiscalYear: before_data.status comes from the locked row, not a pre-tx snapshot', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    // The locked row reports status 'open' — this is the ground truth.
    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(
      makeFiscalYear({ status: 'open' }),
    );
    vi.spyOn(fyRepo, 'updateStatus').mockResolvedValue(makeFiscalYear({ status: 'closed' }));
    const logSpy = vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.status_change', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.closeFiscalYear(FY_ID, COMPANY_A, USER_1);

    const [input] = logSpy.mock.calls[0]!;
    expect(input.before_data).toEqual({ status: 'open' });
    expect(input.after_data).toEqual({ status: 'closed' });
  });

  it('closeFiscalYear: second concurrent close sees status=closed from locked row → throws', async () => {
    const client = makeClient();
    const { service, fyRepo } = makeService(client);

    // Simulate: by the time this transaction acquires the row lock, the first
    // transaction has already committed — the row now shows status='closed'.
    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(
      makeFiscalYear({ status: 'closed' }),
    );

    await expect(
      service.closeFiscalYear(FY_ID, COMPANY_A, USER_1),
    ).rejects.toMatchObject({ code: 'FISCAL_YEAR_ALREADY_CLOSED' });

    // Must not write anything.
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('updateFiscalYear: findByIdForUpdate is called on the client (inside transaction)', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    const forUpdateSpy = vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(
      makeFiscalYear({ status: 'open' }),
    );
    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]);
    vi.spyOn(fyRepo, 'update').mockResolvedValue(makeFiscalYear({ name: 'Renamed' }));
    vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.update', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.updateFiscalYear(FY_ID, COMPANY_A, { name: 'Renamed' }, USER_1);

    expect(forUpdateSpy).toHaveBeenCalledWith(FY_ID, COMPANY_A, client);
  });

  it('updateFiscalYear: before_data reflects the locked row, after_data reflects the updated row', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);

    const lockedRow = makeFiscalYear({ name: 'Old Name', start_date: '2024-01-01', end_date: '2024-12-31', status: 'open' });
    const updatedRow = makeFiscalYear({ name: 'New Name', start_date: '2024-01-01', end_date: '2024-12-31', status: 'open' });

    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(lockedRow);
    vi.spyOn(fyRepo, 'findOverlapping').mockResolvedValue([]);
    vi.spyOn(fyRepo, 'update').mockResolvedValue(updatedRow);
    const logSpy = vi.spyOn(auditRepo, 'logEvent').mockResolvedValue({
      id: AUDIT_ID, company_id: COMPANY_A, actor_user_id: USER_1,
      action: 'fiscal_year.update', entity_type: 'fiscal_year', entity_id: FY_ID,
      before_data: null, after_data: null, reason: null, created_at: new Date(),
    });

    await service.updateFiscalYear(FY_ID, COMPANY_A, { name: 'New Name' }, USER_1);

    const [input] = logSpy.mock.calls[0]!;
    expect(input.before_data).toMatchObject({ name: 'Old Name' });
    expect(input.after_data).toMatchObject({ name: 'New Name' });
  });

  it('updateFiscalYear: concurrent close commits first → second update sees closed → throws', async () => {
    const client = makeClient();
    const { service, fyRepo } = makeService(client);

    // The row lock reveals the FY was closed by a concurrent transaction.
    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(
      makeFiscalYear({ status: 'closed' }),
    );

    await expect(
      service.updateFiscalYear(FY_ID, COMPANY_A, { name: 'Too Late' }, USER_1),
    ).rejects.toMatchObject({ code: 'FISCAL_YEAR_CLOSED_IMMUTABLE' });

    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  });
});


describe('FiscalYearService — close readiness gate', () => {
  it('locks the row, then scope, then re-checks readiness, then updates status (approved order)', async () => {
    const order: string[] = [];
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);
    vi.spyOn(fyRepo, 'findByIdForUpdate').mockImplementation(async () => { order.push('row-lock'); return makeFiscalYear(); });
    vi.mocked(closeGate.loadFiscalYearBounds).mockImplementationOnce(async () => { order.push('bounds'); return { id: FY_ID, start_date: '2024-01-01', end_date: '2024-12-31' }; });
    vi.mocked(closeGate.lockFiscalYearCloseScope).mockImplementationOnce(async () => { order.push('scope-locks'); });
    vi.mocked(closeGate.getFiscalYearCloseReadiness).mockImplementationOnce(async () => { order.push('readiness'); return { ready: true, blockers: [], warnings: [] }; });
    vi.spyOn(fyRepo, 'updateStatus').mockImplementation(async () => { order.push('update'); return makeFiscalYear({ status: 'closed' }); });
    vi.spyOn(auditRepo, 'logEvent').mockImplementation(async () => { order.push('audit'); return {} as never; });

    await service.closeFiscalYear(FY_ID, COMPANY_A, USER_1);

    expect(order).toEqual(['row-lock', 'bounds', 'scope-locks', 'readiness', 'update', 'audit']);
  });

  it('throws FiscalYearCloseBlockedError with structured blockers and writes neither status nor audit', async () => {
    const client = makeClient();
    const { service, fyRepo, auditRepo } = makeService(client);
    vi.spyOn(fyRepo, 'findByIdForUpdate').mockResolvedValue(makeFiscalYear());
    const update = vi.spyOn(fyRepo, 'updateStatus');
    const audit = vi.spyOn(auditRepo, 'logEvent');
    vi.mocked(closeGate.getFiscalYearCloseReadiness).mockResolvedValueOnce({
      ready: false, blockers: [{ code: 'draft_journals', count: 2 }], warnings: [],
    });

    const err = await service.closeFiscalYear(FY_ID, COMPANY_A, USER_1).catch((e) => e);

    expect(err).toBeInstanceOf(closeGate.FiscalYearCloseBlockedError);
    expect((err as closeGate.FiscalYearCloseBlockedError).blockers).toEqual([{ code: 'draft_journals', count: 2 }]);
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(vi.mocked(client.query).mock.calls.map((c) => c[0])).toContain('ROLLBACK');
  });
});
