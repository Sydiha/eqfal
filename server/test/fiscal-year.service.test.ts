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
    // New FY 2024 starts 2024-01-01 — no overlap (2023-12-31 is NOT > 2024-01-01)
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

  it('findOverlapping uses strict inequality — adjacent ranges return no rows', async () => {
    // Verify the overlap formula: existing.start < newEnd AND newStart < existing.end
    // FY-A: start='2023-01-01', end='2024-01-01'
    // New:  start='2024-01-01', end='2025-01-01'
    // newStart (2024-01-01) < existing.end (2024-01-01) → FALSE → no overlap ✓
    const pool = makePool();
    const repo = new FiscalYearRepository(pool);
    const querySpy = pool.query as ReturnType<typeof vi.fn>;
    querySpy.mockResolvedValue({ rows: [], rowCount: 0 });

    await repo.findOverlapping(COMPANY_A, '2024-01-01', '2025-01-01');

    const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
    // Confirm the SQL uses end_date > $2 (strict greater-than) for the start boundary
    expect(sql).toMatch(/end_date\s*>\s*\$2/i);
    expect(params[1]).toBe('2024-01-01');
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

    // Verify the overlap check was called with COMPANY_B, not COMPANY_A
    expect(fyRepo.findOverlapping).toHaveBeenCalledWith(
      COMPANY_B, '2024-01-01', '2024-12-31', undefined,
    );
  });
});

// ─── Cross-company lookup denial ──────────────────────────────────────────────

describe('FiscalYearService — cross-company access denied', () => {
  it('closeFiscalYear: returns "not found or access denied" when companyId does not match', async () => {
    const { service, fyRepo } = makeService();
    // findById with COMPANY_B returns null when the FY belongs to COMPANY_A
    vi.spyOn(fyRepo, 'findById').mockResolvedValue(null);

    await expect(
      service.closeFiscalYear(FY_ID, COMPANY_B, USER_1),
    ).rejects.toThrow(/not found or access denied/i);
  });

  it('updateFiscalYear: returns "not found or access denied" when companyId does not match', async () => {
    const { service, fyRepo } = makeService();
    vi.spyOn(fyRepo, 'findById').mockResolvedValue(null);

    await expect(
      service.updateFiscalYear(FY_ID, COMPANY_B, { name: 'Renamed' }, USER_1),
    ).rejects.toThrow(/not found or access denied/i);
  });

  it('cross-company denial makes no DB write', async () => {
    const { service, fyRepo } = makeService();
    vi.spyOn(fyRepo, 'findById').mockResolvedValue(null);
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
    vi.spyOn(fyRepo, 'findById').mockResolvedValue(makeFiscalYear({ status: 'closed' }));

    await expect(
      service.closeFiscalYear(FY_ID, COMPANY_A, USER_1),
    ).rejects.toThrow(/already closed/i);
  });

  it('updateFiscalYear: throws when fiscal year is closed', async () => {
    const { service, fyRepo } = makeService();
    vi.spyOn(fyRepo, 'findById').mockResolvedValue(makeFiscalYear({ status: 'closed' }));

    await expect(
      service.updateFiscalYear(FY_ID, COMPANY_A, { name: 'New Name' }, USER_1),
    ).rejects.toThrow(/closed and cannot be modified/i);
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

    vi.spyOn(fyRepo, 'findById').mockResolvedValue(openFy);
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

    vi.spyOn(fyRepo, 'findById').mockResolvedValue(makeFiscalYear({ status: 'open' }));
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

    vi.spyOn(fyRepo, 'findById').mockResolvedValue(before);
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

    vi.spyOn(fyRepo, 'findById').mockResolvedValue(makeFiscalYear({ status: 'open' }));
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

    vi.spyOn(fyRepo, 'findById').mockResolvedValue(makeFiscalYear({ status: 'open' }));
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

    vi.spyOn(fyRepo, 'findById').mockResolvedValue(makeFiscalYear({ status: 'open' }));
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
