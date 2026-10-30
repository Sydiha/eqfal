import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const CP = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({ context: null as any, audit: vi.fn(), pool: null as any }));
vi.mock('../src/db/pool', () => ({ get default() { return mocks.pool; } }));
vi.mock('../src/modules/audit-log/audit-log.repository', () => ({ AuditLogRepository: class { logEvent = async (e: unknown, c: unknown) => mocks.audit(e, c); } }));
vi.mock('../src/modules/monthly-close/accounting-period.guard', () => ({
  AccountingPeriodClosedError: class extends Error {},
  assertAccountingDateWritable: vi.fn().mockResolvedValue(undefined),
  lockAccountingRange: vi.fn().mockResolvedValue(undefined),
  assertAccountingRangeWritable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/modules/auth/origin.middleware', () => ({ requireSameOrigin: (_q: Request, _s: Response, n: NextFunction) => n() }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: () => mocks.context,
  requireAuth: (_q: Request, s: Response, n: NextFunction) => (mocks.context ? n() : void s.status(401).end()),
  requireActiveCompany: (_q: Request, s: Response, n: NextFunction) => (mocks.context?.activeCompanyId ? n() : void s.status(403).end()),
  requireCapability: (c: string) => (_q: Request, s: Response, n: NextFunction) => (mocks.context?.capabilities.includes(c) ? n() : void s.status(403).end()),
}));

const mod = await import('../src/modules/obligations/obligation.router');
const { ObligationAgingService } = await import('../src/modules/obligations/obligation-aging');
const app = express();
app.use(express.json());
app.use('/api', mod.obligationRouter);
app.use((_e: unknown, _q: Request, s: Response, _n: NextFunction) => s.status(500).json({ error: 'x' }));

const ctx = (caps: string[]) => (mocks.context = { user: { id: USER }, activeCompanyId: COMPANY, capabilities: caps });

function recordingPool(existing: Record<string, unknown> | null) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const handler = (raw: string, args: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, ' ');
    calls.push({ sql, args });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT * FROM counterparties') && sql.includes('FOR UPDATE')) {
      return existing && args[1] === existing.company_id ? { rows: [existing], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('INSERT INTO counterparties')) {
      return { rows: [{ id: CP, company_id: args[0], name: args[1], type: args[2], labor_relationship: args[3], is_active: true, version: 1 }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE counterparties')) {
      return { rows: [{ ...existing, name: args[2], type: args[3], is_active: args[4], labor_relationship: args[5], version: 2 }], rowCount: 1 };
    }
    throw new Error(sql);
  };
  return { calls, query: vi.fn(async (s: string, a: unknown[] = []) => handler(s, a)), connect: vi.fn(async () => ({ query: async (s: string, a: unknown[] = []) => handler(s, a), release: vi.fn() })) };
}

const stored = { id: CP, company_id: COMPANY, name: 'Ali', type: 'supplier', labor_relationship: null as string | null, is_active: true, version: 1 };

beforeEach(() => { mocks.context = null; mocks.audit.mockReset(); mocks.pool = null; });

describe('G8 counterparty labor relationship: validation and defaults', () => {
  it('defaults to NULL when omitted on create', async () => {
    ctx(['counterparty.create']);
    mocks.pool = recordingPool(null);
    const r = await request(app).post('/api/counterparties').send({ name: 'Ordinary', type: 'supplier' });
    expect(r.status).toBe(201);
    expect(r.body.labor_relationship).toBeNull();
  });

  it.each(['labor_supply', 'contractor', 'individual', 'unresolved'])('stores %s on create', async (value) => {
    ctx(['counterparty.create']);
    mocks.pool = recordingPool(null);
    const r = await request(app).post('/api/counterparties').send({ name: 'W', type: 'supplier', labor_relationship: value });
    expect(r.status).toBe(201);
    expect(r.body.labor_relationship).toBe(value);
    expect(mocks.audit.mock.calls[0]![0]).toMatchObject({ action: 'counterparty.create', company_id: COMPANY, after_data: { labor_relationship: value } });
  });

  it.each(['employee', 'payroll', '', 5, true, {}])('rejects invalid value %j on create and patch', async (value) => {
    ctx(['counterparty.create', 'counterparty.edit']);
    mocks.pool = recordingPool(stored);
    expect((await request(app).post('/api/counterparties').send({ name: 'W', type: 'supplier', labor_relationship: value })).status).toBe(400);
    expect((await request(app).patch(`/api/counterparties/${CP}`).send({ labor_relationship: value, version: 1 })).status).toBe(400);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('G8 counterparty labor relationship: permissions, tenant isolation, audit', () => {
  it('reuses counterparty.create / counterparty.edit and grants nothing new', async () => {
    ctx([]);
    mocks.pool = recordingPool(stored);
    expect((await request(app).post('/api/counterparties').send({ name: 'W', type: 'supplier', labor_relationship: 'individual' })).status).toBe(403);
    expect((await request(app).patch(`/api/counterparties/${CP}`).send({ labor_relationship: 'individual', version: 1 })).status).toBe(403);
    ctx(['counterparty.disable']);
    expect((await request(app).patch(`/api/counterparties/${CP}`).send({ labor_relationship: 'individual', version: 1 })).status).toBe(403);
    ctx(['counterparty.edit']);
    expect((await request(app).patch(`/api/counterparties/${CP}`).send({ labor_relationship: 'individual', version: 1 })).status).toBe(200);
  });

  it('audits before/after and can clear the classification with null', async () => {
    ctx(['counterparty.edit']);
    const pool = recordingPool({ ...stored, labor_relationship: 'unresolved' });
    mocks.pool = pool;
    const r = await request(app).patch(`/api/counterparties/${CP}`).send({ labor_relationship: null, version: 1 });
    expect(r.status).toBe(200);
    expect(r.body.labor_relationship).toBeNull();
    expect(mocks.audit.mock.calls[0]![0]).toMatchObject({
      action: 'counterparty.update', company_id: COMPANY, actor_user_id: USER,
      before_data: { labor_relationship: 'unresolved' }, after_data: { labor_relationship: null },
    });
  });

  it('keeps the existing classification when a patch does not mention it', async () => {
    ctx(['counterparty.edit']);
    mocks.pool = recordingPool({ ...stored, labor_relationship: 'contractor' });
    const r = await request(app).patch(`/api/counterparties/${CP}`).send({ name: 'Renamed', version: 1 });
    expect(r.status).toBe(200);
    expect(r.body.labor_relationship).toBe('contractor');
  });

  it('is tenant scoped: another company cannot read or change the counterparty', async () => {
    ctx(['counterparty.edit']);
    mocks.context.activeCompanyId = OTHER;
    const pool = recordingPool(stored);
    mocks.pool = pool;
    const r = await request(app).patch(`/api/counterparties/${CP}`).send({ labor_relationship: 'individual', version: 1 });
    expect(r.status).toBe(404);
    expect(pool.calls.some((c) => c.sql.startsWith('UPDATE counterparties'))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('scopes every counterparty write by company_id in SQL', () => {
    const src = readFileSync(new URL('../src/modules/obligations/obligation.router.ts', import.meta.url), 'utf8');
    expect(src).toContain('UPDATE counterparties SET name=$3,type=$4,is_active=$5,labor_relationship=$6,version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2');
  });
});

describe('G8 aging report does not hide labor-related counterparties', () => {
  const row = (id: string, labor: string | null, amount: string) => ({
    id, direction: 'payable', counterparty_id: id, counterparty_name: `P${id}`, labor_relationship: labor, source_type: 'manual', document_id: null,
    recognized_on: '2026-01-01', due_on: '2026-01-31', original_amount: amount, adjustment_amount: '0.00', settled_amount: '0.00',
  });

  it('keeps totals unchanged and reports the labor-related portion separately', async () => {
    const db = { query: vi.fn(async () => ({ rows: [row('1', null, '100.00'), row('2', 'individual', '40.00'), row('3', 'unresolved', '10.50')] })) };
    const report: any = await new ObligationAgingService(db as any).report(COMPANY, '2026-03-01');
    expect(report.payables.total_outstanding).toBe('150.50');
    expect(report.payables.labor_related_outstanding).toBe('50.50');
    expect(report.payables.labor_related_count).toBe(2);
    expect(report.payables.items.map((i: any) => i.counterparty_labor_relationship)).toEqual([null, 'individual', 'unresolved']);
    expect(report.receivables.labor_related_count).toBe(0);
  });
});

describe('G8 migration and accounting regression guards', () => {
  it('migration 103 is the next number and only adds one nullable CHECKed column', () => {
    const files = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => /^\d+_/.test(f)).sort();
    expect(files.filter((f) => f.startsWith('103_'))).toEqual(['103_counterparty_labor_relationship.sql']);
    expect(files.some((f) => f.startsWith('098_'))).toBe(false);
    const sql = readFileSync(new URL('../migrations/103_counterparty_labor_relationship.sql', import.meta.url), 'utf8');
    const code = sql.split('\n').filter((l) => !l.startsWith('--')).join('\n');
    expect(code).toMatch(/ALTER TABLE counterparties\s+ADD COLUMN labor_relationship TEXT NULL/);
    expect(code).not.toMatch(/DEFAULT|UPDATE |INSERT |DELETE |DROP |NOT NULL/);
    for (const v of ['labor_supply', 'contractor', 'individual', 'unresolved']) expect(code).toContain(`'${v}'`);
  });

  it('accounting, VAT, WHT, document approval and closing code never read the classification', () => {
    const roots = ['accounting', 'vat', 'wht-reviews', 'documents', 'monthly-close', 'invoices', 'banking'];
    const walk = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : e.name.endsWith('.ts') ? [readFileSync(new URL(e.name, dir), 'utf8')] : []);
    for (const r of roots) for (const src of walk(new URL(`../src/modules/${r}/`, import.meta.url))) expect(src).not.toContain('labor_relationship');
  });
});
