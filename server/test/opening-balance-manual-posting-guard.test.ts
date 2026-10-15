import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const J = '22222222-2222-4222-8222-222222222222';
const FY = '33333333-3333-4333-8333-333333333333';
const REVIEW = '44444444-4444-4444-8444-444444444444';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  context: {
    user: { id: 'user-1', email: 'u@example.com' },
    allowedCompanies: [{ id: 'co-a', name: 'Alpha', name_ar: null }],
    activeCompanyId: 'co-a',
    // Privileged on purpose: every accounting and opening-balance capability is held.
    capabilities: ['accounting.journal.create', 'accounting.journal.edit', 'accounting.journal.post', 'opening_balance.approve'],
  },
}));

vi.mock('../src/db/pool', () => ({
  default: { query: mocks.query, connect: vi.fn(async () => ({ query: mocks.query, release: vi.fn() })) },
}));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => mocks.context),
  requireAuth: (_r: Request, _s: Response, n: NextFunction) => n(),
  requireActiveCompany: (_r: Request, _s: Response, n: NextFunction) => n(),
  requireCapability: () => (_r: Request, _s: Response, n: NextFunction) => n(),
}));
vi.mock('../src/modules/auth/origin.middleware', () => ({
  requireSameOrigin: (_r: Request, _s: Response, n: NextFunction) => n(),
}));

import { accountingRouter } from '../src/modules/accounting/accounting.router';
import { postJournalInTransaction } from '../src/modules/accounting/journal-posting';
import { OpeningBalanceJournalBlockedError } from '../src/modules/accounting/journal-posting-errors';

const app = express();
app.use(express.json());
app.use('/api', accountingRouter);
app.use((e: unknown, _q: Request, res: Response, _n: NextFunction) => res.status(500).json({ error: String(e) }));

type Review = { fiscal_year_id: string; status: string; journal_entry_id: string | null } | null;
function ledger(opts: { entryType?: string; review?: Review; otherPostedOpening?: boolean } = {}) {
  const writes: string[] = [];
  const query = async (sql: string) => {
    if (/UPDATE journal_entries SET status='posted'/.test(sql)) { writes.push('post'); return { rows: [{ id: J, status: 'posted', posted_at: new Date() }], rowCount: 1 }; }
    if (/CURRENT_DATE/.test(sql)) return { rows: [{ today: '2026-12-31' }], rowCount: 1 };
    if (/FROM opening_balance_reviews/.test(sql)) return { rows: opts.review ? [opts.review] : [], rowCount: opts.review ? 1 : 0 };
    if (/entry_type='opening_balance' AND status='posted'/.test(sql)) return { rows: [], rowCount: opts.otherPostedOpening ? 1 : 0 };
    if (/FROM journal_entries WHERE id=\$1/.test(sql)) return { rows: [{ id: J, company_id: 'co-a', fiscal_year_id: FY, accounting_date: '2026-01-01', entry_type: opts.entryType ?? 'opening_balance', status: 'draft', source_type: null, source_id: null }], rowCount: 1 };
    if (/FROM fiscal_years/.test(sql)) return { rows: [{ start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' }], rowCount: 1 };
    if (/FROM journal_lines/.test(sql)) return { rows: [{ count: '2', debit: '10.00', credit: '10.00', active: '2' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { client: { query } as never, writes };
}
const ok: Review = { fiscal_year_id: FY, status: 'in_review', journal_entry_id: null };

describe('manual opening_balance journals are rejected over HTTP even for privileged users', () => {
  beforeEach(() => mocks.query.mockReset());

  it('create', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const r = await request(app).post('/api/journals').send({ fiscal_year_id: FY, accounting_date: '2026-01-01', description: 'x', entry_type: 'opening_balance' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('OPENING_BALANCE_MANUAL_JOURNAL_BLOCKED');
    expect(mocks.query.mock.calls.some(([sql]) => /INSERT INTO journal_entries/.test(String(sql)))).toBe(false);
  });

  it('update to opening_balance', async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      /FOR UPDATE/.test(sql) ? { rows: [{ id: J, fiscal_year_id: FY, accounting_date: '2026-01-01', description: 'x', reference: null, source_type: null, source_id: null, entry_type: 'standard', status: 'draft' }], rowCount: 1 } : { rows: [], rowCount: 0 });
    const r = await request(app).patch(`/api/journals/${J}`).send({ entry_type: 'opening_balance' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('OPENING_BALANCE_MANUAL_JOURNAL_BLOCKED');
    expect(mocks.query.mock.calls.some(([sql]) => /UPDATE journal_entries SET fiscal_year_id/.test(String(sql)))).toBe(false);
  });

  it('post via the manual endpoint', async () => {
    const l = ledger({ review: ok });
    mocks.query.mockImplementation((sql: string) => (l.client as never as { query: (s: string) => Promise<unknown> }).query(sql));
    const r = await request(app).post(`/api/journals/${J}/post`).send();
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('OPENING_BALANCE_MANUAL_JOURNAL_BLOCKED');
    expect(l.writes).toEqual([]);
  });
});

describe('postJournalInTransaction requires a verified in-review opening-balance review', () => {
  const blocked = async (l: ReturnType<typeof ledger>, ctx?: { openingBalanceReviewId?: string }) => {
    await expect(postJournalInTransaction(l.client, 'co-a', 'u', J, ctx)).rejects.toBeInstanceOf(OpeningBalanceJournalBlockedError);
    expect(l.writes).toEqual([]);
  };

  it('no context', () => blocked(ledger({ review: ok })));
  it('review missing or from another company', () => blocked(ledger({ review: null }), { openingBalanceReviewId: REVIEW }));
  it('review of another fiscal year', () => blocked(ledger({ review: { ...ok, fiscal_year_id: 'other' } }), { openingBalanceReviewId: REVIEW }));
  it.each(['draft', 'approved'])('review status %s', (status) => blocked(ledger({ review: { ...ok, status } }), { openingBalanceReviewId: REVIEW }));
  it('review already linked to a journal (repeat approval)', () => blocked(ledger({ review: { ...ok, journal_entry_id: J } }), { openingBalanceReviewId: REVIEW }));
  it('another posted opening journal in the year', () => blocked(ledger({ review: ok, otherPostedOpening: true }), { openingBalanceReviewId: REVIEW }));

  it('valid review context posts exactly once', async () => {
    const l = ledger({ review: ok });
    await postJournalInTransaction(l.client, 'co-a', 'u', J, { openingBalanceReviewId: REVIEW });
    expect(l.writes).toEqual(['post']);
  });

  it('standard journals are unaffected and ignore the context', async () => {
    const l = ledger({ entryType: 'standard' });
    await postJournalInTransaction(l.client, 'co-a', 'u', J);
    expect(l.writes).toEqual(['post']);
  });
});
