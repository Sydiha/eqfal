import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// T7.2: opening-balance file preview (read-only) and draft-only bulk import, with mocked auth, guards and database.
const mocks = vi.hoisted(() => ({
  context: null as null | { user: { id: string; email: string }; allowedCompanies: never[]; activeCompanyId: string | null; capabilities: string[] },
  query: vi.fn(), connect: vi.fn(), cutoverPath: vi.fn(), periodWritable: vi.fn(), audit: vi.fn(),
}));
vi.mock('../src/db/pool', () => ({ default: { query: mocks.query, connect: mocks.connect } }));
vi.mock('../src/config', () => ({ default: { bankStorageDir: '/tmp/eqfal-bank-test' } }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => mocks.context),
  requireAuth: (_q: Request, res: Response, next: NextFunction) => (mocks.context ? next() : void res.status(401).json({ error: 'Unauthenticated' })),
  requireActiveCompany: (_q: Request, res: Response, next: NextFunction) => (mocks.context?.activeCompanyId ? next() : void res.status(403).json({ error: 'No active company' })),
  requireCapability: (c: string) => (_q: Request, res: Response, next: NextFunction) => (mocks.context?.capabilities.includes(c) ? next() : void res.status(403).json({ error: 'Forbidden' })),
}));
vi.mock('../src/modules/auth/origin.middleware', () => ({ requireSameOrigin: (_q: Request, _r: Response, next: NextFunction) => next() }));
vi.mock('../src/modules/audit-log/audit-log.repository', () => ({ AuditLogRepository: class { logEvent = mocks.audit; } }));
vi.mock('../src/modules/accounting/ledger-source-authority', async (orig) => ({ ...(await orig<object>()), assertFiscalYearNotInCutoverPath: mocks.cutoverPath }));
vi.mock('../src/modules/monthly-close/accounting-period.guard', async (orig) => ({ ...(await orig<object>()), assertAccountingDateWritable: mocks.periodWritable }));

import { openingBalancesRouter } from '../src/modules/opening-balances/opening-balances.router';
import { AccountingPeriodClosedError } from '../src/modules/monthly-close/accounting-period.guard';
import { LedgerSourceAuthorityBlockedError } from '../src/modules/accounting/journal-posting';

const FY = '11111111-1111-4111-8111-111111111111';
const A1 = '22222222-2222-4222-8222-222222222221', A2 = '22222222-2222-4222-8222-222222222222', A3 = '22222222-2222-4222-8222-222222222223';
const FOREIGN = '22222222-2222-4222-8222-222222222229';
const PARTNER = '33333333-3333-4333-8333-333333333331';
const ACCOUNTS = [{ id: A1, code: '1101', is_active: true }, { id: A2, code: '3101', is_active: true }, { id: A3, code: '2101', is_active: true }];
const CREATE = 'opening_balance.item.create';

type State = { review: null | { id: string; status: string }; items: number; partners: Record<string, boolean>; fyStatus: string };
let state: State; let writes: string[];
const client = {
  release: vi.fn(),
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
    if (s.startsWith('INSERT') || s.startsWith('UPDATE') || s.startsWith('DELETE')) writes.push(s);
    if (s.includes('FROM fiscal_years')) return { rows: [{ id: FY, start_date: '2026-01-01', end_date: '2026-12-31', status: state.fyStatus }] };
    if (s.startsWith('INSERT INTO opening_balance_reviews')) { if (state.review) return { rows: [] }; state.review = { id: 'r1', status: 'draft' }; return { rows: [state.review] }; }
    if (s.includes('FROM opening_balance_reviews')) return { rows: state.review ? [state.review] : [] };
    if (s.includes('COUNT(*)') && s.includes('opening_balance_items')) return { rows: [{ n: String(state.items) }] };
    if (s.startsWith('SELECT 1 FROM opening_balance_items')) return { rows: state.items ? [{}] : [], rowCount: state.items ? 1 : 0 };
    if (s.includes('FROM accounts') && s.includes('ANY')) return { rows: ACCOUNTS.filter((a) => (params[1] as string[]).includes(a.id)) };
    if (s.includes('FROM accounts')) return { rows: ACCOUNTS };
    if (s.includes('company_accounting_profiles')) return { rows: [{ functional_currency: 'SAR' }] };
    if (s.includes('FROM partners')) { const p = state.partners[String(params[0])]; return { rows: p === undefined ? [] : [{ is_active: p }] }; }
    if (s.startsWith('INSERT INTO opening_balance_items')) { state.items++; return { rows: [{ id: `i${state.items}`, amount: params[4], balance_side: params[5], category: params[2] }] }; }
    throw new Error(`unexpected query ${s.slice(0, 80)}`);
  }),
};

const app = express(); app.use(express.json()); app.use('/api', openingBalancesRouter);
app.use((err: unknown, _q: Request, res: Response, _n: NextFunction) => res.status(500).json({ error: err instanceof Error ? err.message : 'error' }));
const setCtx = (capabilities: string[]) => { mocks.context = { user: { id: 'u1', email: 'u@x.com' }, allowedCompanies: [], activeCompanyId: 'co-a', capabilities }; };
const parse = (body: Buffer, name: string, mime: string, extra: Record<string, string> = {}) =>
  request(app).post(`/api/opening-balances/${FY}/import/parse-file`).set('content-type', mime).set('x-file-name', encodeURIComponent(name)).set(extra).send(body);
const csv = (text: string, extra: Record<string, string> = {}) => parse(Buffer.from(text), 'ob.csv', 'text/csv', extra);
const item = (o: Record<string, unknown> = {}) => ({ row: 2, account_id: A1, debit: '1000.50', credit: '0.00', category: 'bank', partner_id: null, ...o });
const good = () => ({ confirm: true, file_name: 'ob.xlsx', items: [item(), item({ row: 3, account_id: A2, debit: '0.00', credit: '1000.50', category: 'equity' })] });
const imp = (body: unknown) => request(app).post(`/api/opening-balances/${FY}/import`).send(body as object);

beforeEach(() => {
  mocks.context = null; state = { review: null, items: 0, partners: { [PARTNER]: true }, fyStatus: 'open' }; writes = [];
  mocks.query.mockReset(); mocks.connect.mockReset().mockResolvedValue(client); client.query.mockClear();
  mocks.cutoverPath.mockReset().mockResolvedValue(undefined); mocks.periodWritable.mockReset().mockResolvedValue(undefined); mocks.audit.mockReset();
});

describe('T7.2 opening-balance file preview', () => {
  it('requires opening_balance.item.create', async () => {
    setCtx(['opening_balance.view']);
    expect((await csv('Code,Debit,Credit\n1101,5,\n3101,,5\n')).status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('previews an English CSV with exact amounts and writes nothing', async () => {
    setCtx([CREATE]);
    const res = await csv('Account Code,Debit,Credit\n1101,"1,234,567.89",\n3101,,1234567.89\n');
    expect(res.status).toBe(200); expect(res.body.status).toBe('parsed'); expect(res.body.balanced).toBe(true);
    expect(res.body.lines.map((l: { debit: string; credit: string }) => [l.debit, l.credit])).toEqual([['1234567.89', '0.00'], ['0.00', '1234567.89']]);
    expect(res.body.import_allowed).toBe(true);
    expect(writes).toEqual([]);
  });
  it('previews Arabic headings and Arabic numerals', async () => {
    setCtx([CREATE]);
    const res = await csv('رقم الحساب,اسم الحساب,مدين,دائن\n١١٠١,البنك,٢٥٠٫٧٥,\n٣١٠١,رأس المال,,٢٥٠٫٧٥\n');
    expect(res.body.status).toBe('parsed'); expect(res.body.lines.map((l: { code: string }) => l.code)).toEqual(['1101', '3101']);
    expect(res.body.total_debit).toBe('250.75'); expect(res.body.balanced).toBe(true);
  });
  it('asks for explicit mapping on unknown headings and accepts one', async () => {
    setCtx([CREATE]);
    const text = 'Ref,Left,Right\n1101,10,\n3101,,10\n';
    expect((await csv(text)).body.status).toBe('needs_mapping');
    const mapped = await csv(text, { 'x-tb-mapping': encodeURIComponent(JSON.stringify({ header_row: 1, code: 0, debit: 1, credit: 2 })) });
    expect(mapped.body.status).toBe('parsed'); expect(mapped.body.balanced).toBe(true);
  });
  it('flags unbalanced files, unknown and duplicate codes per row', async () => {
    setCtx([CREATE]);
    const codes = (await csv('Code,Debit,Credit\n1101,10,\n1101,5,\n9999,,3\n')).body.errors.map((e: { code: string }) => e.code);
    expect(codes).toEqual(expect.arrayContaining(['TB_UNBALANCED', 'TB_ACCOUNT_DUPLICATE', 'TB_ACCOUNT_UNMATCHED']));
  });
  it('reports a non-empty draft as not importable', async () => {
    setCtx([CREATE]); state.review = { id: 'r1', status: 'draft' }; state.items = 2;
    expect((await csv('Code,Debit,Credit\n1101,5,\n3101,,5\n')).body.import_allowed).toBe(false);
  });
});

describe('T7.2 opening-balance bulk import', () => {
  it('requires opening_balance.item.create and explicit confirmation', async () => {
    setCtx(['opening_balance.view']); expect((await imp(good())).status).toBe(403);
    setCtx([CREATE]);
    expect((await imp({ ...good(), confirm: false })).status).toBe(400);
    expect((await imp({ ...good(), extra: 1 })).status).toBe(400);
    expect((await imp({ ...good(), items: [item({ debit: '1000.5' }), good().items[1]] })).status).toBe(400);
    expect((await imp({ ...good(), items: [item({ category: 'sales' }), good().items[1]] })).status).toBe(400);
    expect(writes).toEqual([]);
  });
  it('creates draft items only, exact amounts, one audit per item plus a summary, and never posts or approves', async () => {
    setCtx([CREATE]);
    const res = await imp(good()); expect(res.status).toBe(201);
    expect(res.body.items.map((i: { amount: string; balance_side: string }) => [i.amount, i.balance_side])).toEqual([['1000.50', 'debit'], ['1000.50', 'credit']]);
    expect(writes.every((w) => /^INSERT INTO opening_balance_(reviews|items)/.test(w))).toBe(true);
    expect(writes.some((w) => /journal|approved/i.test(w))).toBe(false);
    expect(mocks.audit.mock.calls.map((c) => c[0].action)).toEqual(['opening_balance.create', 'opening_balance_item.create', 'opening_balance_item.create', 'opening_balance.import']);
    const inserted = client.query.mock.calls.filter((c) => String(c[0]).startsWith('INSERT INTO opening_balance_items'));
    expect(inserted.every((c) => String(c[0]).includes("'internal_ledger'") && String((c[1] as unknown[])[7]).startsWith('import:ob.xlsx:row '))).toBe(true);
  });
  it('a retried request cannot add rows twice: the second call sees a non-empty draft', async () => {
    setCtx([CREATE]);
    expect((await imp(good())).status).toBe(201);
    const again = await imp(good()); expect(again.status).toBe(409); expect(again.body.code).toBe('IMPORT_DRAFT_NOT_EMPTY');
    expect(state.items).toBe(2);
  });
  it('rejects a non-draft review', async () => {
    setCtx([CREATE]); state.review = { id: 'r1', status: 'in_review' };
    const res = await imp(good()); expect(res.status).toBe(409); expect(res.body.code).toBe('IMPORT_NOT_DRAFT'); expect(state.items).toBe(0);
  });
  it('rejects unbalanced batches, both-sided rows, duplicate accounts and accounts of another company', async () => {
    setCtx([CREATE]);
    const codeOf = async (items: unknown[]) => (await imp({ ...good(), items })).body.code;
    expect(await codeOf([item(), item({ row: 3, account_id: A2, debit: '0.00', credit: '1000.49', category: 'equity' })])).toBe('TB_UNBALANCED');
    expect(await codeOf([item({ credit: '1.00' }), good().items[1]])).toBe('TB_BOTH_DEBIT_CREDIT');
    expect(await codeOf([item(), item({ row: 3, debit: '0.00', credit: '1000.50' })])).toBe('TB_ACCOUNT_DUPLICATE');
    expect(await codeOf([item({ account_id: FOREIGN }), good().items[1]])).toBe('TB_ACCOUNT_UNMATCHED');
    expect(state.items).toBe(0);
  });
  it('requires an active company partner for partner categories and refuses one elsewhere', async () => {
    setCtx([CREATE]);
    const cap = (o: Record<string, unknown>) => item({ row: 3, account_id: A2, debit: '0.00', credit: '1000.50', category: 'partner_capital', ...o });
    expect((await imp({ ...good(), items: [item(), cap({})] })).body.code).toBe('IMPORT_PARTNER_INVALID');
    expect((await imp({ ...good(), items: [item({ partner_id: PARTNER }), cap({ partner_id: PARTNER })] })).body.code).toBe('IMPORT_PARTNER_INVALID');
    expect((await imp({ ...good(), items: [item(), cap({ partner_id: '33333333-3333-4333-8333-333333333339' })] })).body.code).toBe('IMPORT_PARTNER_INVALID');
    expect(state.items).toBe(0);
    expect((await imp({ ...good(), items: [item(), cap({ partner_id: PARTNER })] })).status).toBe(201);
  });
  it('accepts a company with only assets and equity (no sales, purchases, customers or inventory)', async () => {
    setCtx([CREATE]);
    const res = await imp({ ...good(), items: [item({ category: 'other_asset' }), item({ row: 3, account_id: A2, debit: '0.00', credit: '1000.50', category: 'equity' })] });
    expect(res.status).toBe(201);
  });
  it('honours closed fiscal years, closed periods and the cut-over path', async () => {
    setCtx([CREATE]);
    state.fyStatus = 'closed';
    expect((await imp(good())).body.code).toBe('FISCAL_YEAR_CLOSED');
    state.fyStatus = 'open';
    mocks.periodWritable.mockRejectedValueOnce(new AccountingPeriodClosedError());
    expect((await imp(good())).body.code).toBe('ACCOUNTING_PERIOD_CLOSED');
    mocks.cutoverPath.mockRejectedValueOnce(new LedgerSourceAuthorityBlockedError('ONBOARDING_PATH_CUTOVER_ACTIVE', 'cut-over'));
    const cut = await imp(good()); expect(cut.status).toBe(409); expect(cut.body.code).toBe('ONBOARDING_PATH_CUTOVER_ACTIVE');
    expect(state.items).toBe(0);
  });
});

describe('PR-2B review lifecycle conflict codes', () => {
  it('adds OB_REVIEW_NOT_DRAFT when submitting a review that is not a draft, keeping 409 and the message', async () => {
    setCtx(['opening_balance.submit']); state.review = { id: 'r1', status: 'in_review' };
    const res = await request(app).post(`/api/opening-balances/${FY}/submit-review`).send({});
    expect(res.status).toBe(409); expect(res.body).toEqual({ error: 'Only draft can be submitted', code: 'OB_REVIEW_NOT_DRAFT' });
  });
  it('adds OB_REVIEW_NOT_IN_REVIEW when approving a draft review', async () => {
    setCtx(['opening_balance.approve']); state.review = { id: 'r1', status: 'draft' };
    const res = await request(app).post(`/api/opening-balances/${FY}/approve`).send({});
    expect(res.status).toBe(409); expect(res.body).toEqual({ error: 'Only in-review opening balance can be approved', code: 'OB_REVIEW_NOT_IN_REVIEW' });
  });
});
