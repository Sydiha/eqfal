import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ client: null as unknown, pool: { connect: vi.fn() } }));

vi.mock('../src/db/pool', () => ({ default: mocks.pool }));
vi.mock('../src/modules/auth/origin.middleware', () => ({ requireSameOrigin: (_q: Request, _s: Response, n: NextFunction) => n() }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => ({ user: { id: 'user-1' }, activeCompanyId: 'co-a', capabilities: [] })),
  requireAuth: (_q: Request, _s: Response, n: NextFunction) => n(),
  requireActiveCompany: (_q: Request, _s: Response, n: NextFunction) => n(),
  requireCapability: () => (_q: Request, _s: Response, n: NextFunction) => n(),
}));

import { openingBalancesRouter } from '../src/modules/opening-balances/opening-balances.router';
import { periodicAdjustmentsRouter } from '../src/modules/periodic-adjustments/periodic-adjustments.router';
import { accountingRouter } from '../src/modules/accounting/accounting.router';

const app = express();
app.use(express.json());
app.use('/api', openingBalancesRouter, periodicAdjustmentsRouter, accountingRouter);
app.use((e: unknown, _q: Request, res: Response, _n: NextFunction) => { res.status(500).json({ error: String(e) }); });

const FY = '11111111-1111-4111-8111-111111111111';
const JID = '22222222-2222-4222-8222-222222222222';
const ADJ = '33333333-3333-4333-8333-333333333333';
const SCH = '44444444-4444-4444-8444-444444444444';
const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });

/** Scripted transactional client: FY is closed; records every statement. */
function scriptedClient(handlers: Array<[string, (p: unknown[]) => unknown[]]>) {
  const log: string[] = [];
  const client = {
    release: vi.fn(),
    async query(sql: string, p: unknown[] = []) {
      log.push(sql);
      if (sql.includes('FROM fiscal_years') && sql.includes('FOR SHARE')) {
        return rows([{ start_date: '2025-01-01', end_date: '2025-12-31', status: 'closed' }]);
      }
      if (sql.includes('monthly_close_periods')) return rows([]);
      for (const [needle, fn] of handlers) if (sql.includes(needle)) return rows(fn(p));
      return rows([]);
    },
  };
  mocks.client = client;
  mocks.pool.connect.mockResolvedValue(client);
  return log;
}

const draftJournal = (extra: object = {}) => ({
  id: JID, company_id: 'co-a', fiscal_year_id: FY, accounting_date: '2025-01-01', description: 'd', reference: null,
  source_type: null, source_id: null, entry_type: 'standard', status: 'draft', ...extra,
});
const noWrites = (log: string[]) => {
  expect(log).toContain('ROLLBACK');
  expect(log).not.toContain('COMMIT');
  expect(log.some(s => s.includes("SET status='posted'"))).toBe(false);
  expect(log.some(s => s.includes('INSERT INTO audit_log'))).toBe(false);
};

describe('closed fiscal year through real route/service flows', () => {
  beforeEach(() => mocks.pool.connect.mockReset());

  it('opening-balance approve -> 409 Fiscal year is closed; nothing posted, no approve audit, rolled back', async () => {
    const log = scriptedClient([
      ['FROM fiscal_years WHERE id=$1 AND company_id=$2', () => [{ id: FY, start_date: '2025-01-01', end_date: '2025-12-31' }]],
      ['FROM opening_balance_reviews', () => [{ id: 'rev1', status: 'in_review', journal_entry_id: null }]],
      ['FROM opening_balance_items', () => [
        { account_id: 'a1', account_code: '1000', debit: '100.00', credit: '0.00' },
        { account_id: 'a2', account_code: '3000', debit: '0.00', credit: '100.00' },
      ]],
      ['INSERT INTO journal_entries', () => [draftJournal({ entry_type: 'opening_balance' })]],
      ['FROM journal_entries WHERE id=$1', () => [draftJournal({ entry_type: 'opening_balance' })]],
    ]);
    const res = await request(app).post(`/api/opening-balances/${FY}/approve`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Fiscal year is closed');
    expect(res.body.code).toBe('FISCAL_YEAR_CLOSED');
    noWrites(log);
    expect(log.some(s => s.includes("UPDATE opening_balance_reviews SET status='approved'"))).toBe(false);
  });

  it('periodic-adjustment postLine -> 409; schedule stays pending, nothing posted, no audit', async () => {
    const log = scriptedClient([
      ['FROM periodic_adjustments WHERE id=$1', () => [{ id: ADJ, workflow_status: 'approved', adjustment_type: 'accrued_expense', description: 'd', reference: null, pnl_account_id: 'p', balance_account_id: 'b' }]],
      ['FROM periodic_adjustment_schedule WHERE id=$1', () => [{ id: SCH, status: 'pending', journal_entry_id: null, recognition_date: '2025-01-01', amount: '10.00' }]],
      ['CURRENT_DATE', () => [{ today: '2026-10-06' }]],
      ['FROM fiscal_years WHERE company_id=$1 AND start_date<=$2', () => [{ id: FY }]],
      ['INSERT INTO journal_entries', () => [{ id: JID }]],
      ['FROM journal_entries WHERE id=$1', () => [draftJournal({ source_type: 'periodic_adjustment', source_id: SCH })]],
    ]);
    const res = await request(app).post(`/api/periodic-adjustments/${ADJ}/schedule/${SCH}/post`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Fiscal year is closed');
    expect(res.body.code).toBe('FISCAL_YEAR_CLOSED');
    noWrites(log);
    expect(log.some(s => s.includes('UPDATE periodic_adjustment_schedule'))).toBe(false);
  });

  it('accounting manual journal POST route maps the closed-year error to 409', async () => {
    const log = scriptedClient([
      ['FROM journal_entries WHERE id=$1', () => [draftJournal()]],
    ]);
    const res = await request(app).post(`/api/journals/${JID}/post`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Fiscal year is closed');
    expect(res.body.code).toBe('FISCAL_YEAR_CLOSED');
    noWrites(log);
  });
});
