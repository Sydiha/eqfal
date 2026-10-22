import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { deflateRawSync } from 'zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as null | { user: { id: string; email: string }; allowedCompanies: never[]; activeCompanyId: string | null; capabilities: string[] },
  query: vi.fn(), connect: vi.fn(),
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

import { ledgerSourceAuthorityRouter } from '../src/modules/ledger-source-authority/ledger-source-authority.router';
import { parseAmount, parseTrialBalanceTable, RawRow, TbAccount } from '../src/modules/accounting/cutover-file-import';

const RID = '33333333-3333-4333-8333-333333333333';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ACC: TbAccount[] = [
  { id: 'a1', code: '1000', is_active: true }, { id: 'a2', code: '2000', is_active: true }, { id: 'a3', code: '3000', is_active: false },
  { id: 'a4', code: '4000', is_active: true }, { id: 'a5', code: '4000', is_active: true },
];
const rows = (...r: Array<Array<string | number | null>>): RawRow[] => r.map((cells, i) => ({ sourceRowNumber: i + 1, cells }));
const parse = (r: RawRow[], accounts = ACC, opts: Parameters<typeof parseTrialBalanceTable>[3] = { functionalCurrency: 'SAR' }) => parseTrialBalanceTable(r, new Set(), accounts, opts);

function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text); const comp = deflateRawSync(raw); const n = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, n, comp); centrals.push(c, n); offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(locals.length / 3, 8); end.writeUInt16LE(locals.length / 3, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function xlsx(table: Array<Array<string | number>>, formulaAt?: string): Buffer {
  const cell = (v: string | number, ref: string) => `<c r="${ref}"${typeof v === 'number' ? '' : ' t="inlineStr"'}>${formulaAt === ref ? '<f>1+1</f>' : ''}${typeof v === 'number' ? `<v>${v}</v>` : `<is><t>${v}</t></is>`}</c>`;
  const sheet = `<worksheet><sheetData>${table.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(v, `${String.fromCharCode(65 + j)}${i + 1}`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  return zip({ 'xl/worksheets/sheet1.xml': sheet });
}

const app = express(); app.use('/api', ledgerSourceAuthorityRouter);
app.use((err: unknown, _q: Request, res: Response, _n: NextFunction) => res.status(500).json({ error: err instanceof Error ? err.message : 'error' }));
const setCtx = (capabilities: string[]) => { mocks.context = { user: { id: 'u1', email: 'u@x.com' }, allowedCompanies: [], activeCompanyId: 'co-a', capabilities }; };
const mockDb = (status = 'draft') => {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM ledger_source_authority')) return { rows: [{ to_date: '2026-08-31', status }] };
    if (sql.includes('FROM accounts')) return { rows: ACC.filter((a) => a.code !== '4000') };
    if (sql.includes('company_accounting_profiles')) return { rows: [{ functional_currency: 'SAR' }] };
    throw new Error(`unexpected query ${sql}`);
  });
};
const post = (body: Buffer, name = 'tb.xlsx', mime = XLSX, extra: Record<string, string> = {}) =>
  request(app).post(`/api/ledger-source-authority/${RID}/cutover/parse-file`).set('content-type', mime).set('x-file-name', encodeURIComponent(name)).set(extra).send(body);
beforeEach(() => { mocks.context = null; mocks.query.mockReset(); mocks.connect.mockReset(); });

describe('I1 trial balance parsing', () => {
  it('debit/credit columns produce exact debit/credit', () => {
    const r = parse(rows(['Account Code', 'Account Name', 'Debit', 'Credit'], ['1000', 'Cash', '1,000.50', null], ['2000', 'AP', null, 1000.5]));
    expect(r.status).toBe('parsed'); if (r.status !== 'parsed') return;
    expect(r.errors).toEqual([]); expect(r.balanced).toBe(true);
    expect(r.lines.map((l) => [l.account_id, l.debit, l.credit])).toEqual([['a1', '1000.50', '0.00'], ['a2', '0.00', '1000.50']]);
  });
  it('signed balance column: positive is debit, negative or parentheses is credit', () => {
    const r = parse(rows(['كود الحساب', 'الرصيد'], ['1000', '500'], ['2000', '(200.25)'], ['3000', '-299.75']), ACC);
    if (r.status !== 'parsed') throw new Error('expected parsed');
    expect(r.lines.map((l) => [l.debit, l.credit])).toEqual([['500.00', '0.00'], ['0.00', '200.25'], ['0.00', '299.75']]);
    expect(r.balanced).toBe(true);
  });
  it('asks for explicit mapping when columns are ambiguous or undetectable, and accepts one', () => {
    const t = rows(['Ref', 'X', 'Y'], ['1000', '5', null], ['2000', null, '5']);
    const first = parse(t); expect(first.status).toBe('needs_mapping');
    const r = parse(t, ACC, { functionalCurrency: 'SAR', mapping: { header_row: 1, code: 0, debit: 1, credit: 2 } });
    if (r.status !== 'parsed') throw new Error('expected parsed'); expect(r.balanced).toBe(true);
    expect(parse(rows(['Account', 'Debit', 'Credit', 'Balance'], ['1000', 1, null, 1])).status).toBe('needs_mapping');
  });
  it('flags unmatched, inactive, ambiguous and duplicate accounts and never matches by name', () => {
    const r = parse(rows(['Code', 'Name', 'Debit', 'Credit'], ['9999', 'Cash', 10, null], ['3000', 'Inactive', 5, null], ['4000', 'Dup code in COA', null, 10], ['1000', 'A', null, 5], ['1000', 'A again', null, 0.01]));
    if (r.status !== 'parsed') throw new Error('expected parsed');
    expect(r.lines.map((l) => l.status)).toEqual(['unmatched', 'inactive', 'ambiguous', 'duplicate', 'duplicate']);
    expect(r.lines.every((l) => l.account_id === null)).toBe(true);
    expect(r.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['TB_ACCOUNT_UNMATCHED', 'TB_ACCOUNT_INACTIVE', 'TB_ACCOUNT_AMBIGUOUS', 'TB_ACCOUNT_DUPLICATE']));
  });
  it('rejects unbalanced, both-sided, negative-in-debit/credit and malformed amounts', () => {
    const base = ['Code', 'Debit', 'Credit'];
    const un = parse(rows(base, ['1000', 10, null], ['2000', null, 9]));
    if (un.status !== 'parsed') throw new Error('x'); expect(un.balanced).toBe(false); expect(un.errors.map((e) => e.code)).toContain('TB_UNBALANCED');
    const bad = parse(rows(base, ['1000', 10, 5], ['2000', -4, null], ['3000', '1.234', null], ['1000', 'abc', null]));
    if (bad.status !== 'parsed') throw new Error('x');
    expect(bad.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['TB_BOTH_DEBIT_CREDIT', 'TB_NEGATIVE_IN_DEBIT_CREDIT', 'TB_AMOUNT_INVALID']));
  });
  it('skips zero and total rows with warnings and enforces the functional currency', () => {
    const r = parse(rows(['Code', 'Debit', 'Credit', 'Currency'], ['1000', 10, null, 'SAR'], ['2000', null, 10, 'sar'], ['2000', 0, 0, 'SAR'], ['Total', 10, 10, null]));
    if (r.status !== 'parsed') throw new Error('x'); expect(r.errors).toEqual([]); expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['TB_ZERO_ROW_SKIPPED', 'TB_TOTAL_ROW_IGNORED']));
    const usd = parse(rows(['Code', 'Debit', 'Credit', 'Currency'], ['1000', 10, null, 'USD'], ['2000', null, 10, 'SAR']));
    if (usd.status !== 'parsed') throw new Error('x'); expect(usd.errors.map((e) => e.code)).toContain('TB_CURRENCY_MISMATCH');
    const none = parse(rows(['Code', 'Debit', 'Credit', 'Currency'], ['1000', 10, null, 'SAR'], ['2000', null, 10, 'SAR']), ACC, { functionalCurrency: null });
    if (none.status !== 'parsed') throw new Error('x'); expect(none.errors.map((e) => e.code)).toContain('TB_CURRENCY_UNVERIFIABLE');
  });
  it('a totals row that disagrees with the lines, or an account with no amount, is an error not a silent skip', () => {
    const t = parse(rows(['Code', 'Name', 'Debit', 'Credit'], ['1000', 'A', 10, null], ['2000', 'B', null, 10], [null, 'Total', 25, 25]));
    if (t.status !== 'parsed') throw new Error('x'); expect(t.errors.map((e) => e.code)).toContain('TB_TOTAL_ROW_MISMATCH');
    const blank = parse(rows(['Code', 'Debit', 'Credit'], ['1000', 10, null], ['2000', null, 10], ['3000', null, null]));
    if (blank.status !== 'parsed') throw new Error('x'); expect(blank.errors.map((e) => e.code)).toContain('TB_AMOUNT_MISSING');
  });
  it('T7.2: Arabic-Indic digits in codes match exactly on both sides; folded duplicates are caught; no prefix or name match', () => {
    const ar = parse(rows(['رقم الحساب', 'مدين', 'دائن'], ['١٠٠٠', '٥٠', ''], ['2000', '', '50']));
    expect(ar.status === 'parsed' && ar.lines.map((l) => [l.code, l.account_id, l.status])).toEqual([['1000', 'a1', 'ok'], ['2000', 'a2', 'ok']]);
    const chartAr = parse(rows(['Code', 'Debit', 'Credit'], ['1000', 5, ''], ['2000', '', 5]), [{ id: 'x1', code: '١٠٠٠', is_active: true }, { id: 'x2', code: '2000', is_active: true }]);
    expect(chartAr.status === 'parsed' && chartAr.lines.map((l) => l.account_id)).toEqual(['x1', 'x2']);
    const dup = parse(rows(['Code', 'Debit', 'Credit'], ['١٠٠٠', 5, ''], ['1000', 5, ''], ['2000', '', 10]));
    expect(dup.status === 'parsed' && dup.lines.filter((l) => l.status === 'duplicate').map((l) => l.row)).toEqual([2, 3]);
    const near = parse(rows(['Code', 'Name', 'Debit', 'Credit'], ['100', 'Cash', 5, ''], ['10000', 'x', '', 3], ['٢٠٠٠٠', 'y', '', 2]));
    expect(near.status === 'parsed' && near.lines.map((l) => l.status)).toEqual(['unmatched', 'unmatched', 'unmatched']);
    const mapped = parse(rows(['Ref', 'L', 'R'], ['١٠٠٠', 7, ''], ['2000', '', 7]), ACC, { mapping: { header_row: 1, code: 0, debit: 1, credit: 2 }, functionalCurrency: 'SAR' });
    expect(mapped.status === 'parsed' && mapped.balanced && mapped.lines[0]!.account_id).toBe('a1');
    expect(parse(rows(['Ref', 'L', 'R'], ['1000', 7, ''])).status).toBe('needs_mapping');
  });
  it('parseAmount is exact and never rounds', () => {
    expect(parseAmount('1,234.56')).toBe(123456n); expect(parseAmount('٣٫٥٠')).toBe(350n); expect(parseAmount('12-')).toBe(-1200n);
    expect(() => parseAmount('1.005')).toThrow(); expect(() => parseAmount(0.125)).toThrow(); expect(() => parseAmount('1e5')).toThrow();
  });
});

describe('I1 parse-file endpoint', () => {
  const good = [['Account Code', 'Debit', 'Credit'], ['1000', 100, ''], ['2000', '', 100]];
  it('requires source_authority.activate (403) and does not query', async () => {
    setCtx(['bank.import']); mockDb();
    expect((await post(xlsx(good as never))).status).toBe(403); expect(mocks.query).not.toHaveBeenCalled();
  });
  it('parses a valid XLSX read-only: only SELECT queries, no connection/transaction', async () => {
    setCtx(['source_authority.activate']); mockDb();
    const res = await post(xlsx(good as never)); expect(res.status).toBe(200);
    expect(res.body.status).toBe('parsed'); expect(res.body.balanced).toBe(true); expect(res.body.lines).toHaveLength(2);
    const again = await post(xlsx(good as never)); expect(again.body).toEqual(res.body);
    for (const [sql] of mocks.query.mock.calls) expect(String(sql).trim().toUpperCase().startsWith('SELECT')).toBe(true);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('parses a valid CSV', async () => {
    setCtx(['source_authority.activate']); mockDb();
    const res = await post(Buffer.from('Code,Debit,Credit\n1000,50,\n2000,,50\n'), 'tb.csv', 'text/csv'); expect(res.status).toBe(200); expect(res.body.balanced).toBe(true);
  });
  it('rejects formulas, unsafe archives, bad types and bad mapping', async () => {
    setCtx(['source_authority.activate']); mockDb();
    const f = await post(xlsx(good as never, 'B2')); expect(f.status).toBe(200); expect(f.body.errors.map((e: { code: string }) => e.code)).toContain('TB_FORMULA_NOT_ALLOWED');
    expect((await post(Buffer.from('PK\x03\x04garbage'))).status).toBe(400);
    expect((await post(Buffer.from('x'), 'tb.txt', 'text/plain')).status).toBe(400);
    expect((await post(Buffer.from('Code,Debit,Credit\n'), 'tb.csv', 'text/csv', { 'x-tb-mapping': 'not-json' })).status).toBe(400);
  });
  it('rejects a multi-sheet workbook instead of reading only the first sheet', async () => {
    setCtx(['source_authority.activate']); mockDb();
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Code</t></is></c><c r="B1" t="inlineStr"><is><t>Debit</t></is></c><c r="C1" t="inlineStr"><is><t>Credit</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>1000</t></is></c><c r="B2"><v>5</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>2000</t></is></c><c r="C3"><v>5</v></c></row></sheetData></worksheet>';
    const res = await post(zip({ 'xl/worksheets/sheet1.xml': sheet, 'xl/worksheets/sheet2.xml': sheet }));
    expect(res.status).toBe(200); expect(res.body.errors.map((e: { code: string }) => e.code)).toContain('TB_MULTIPLE_SHEETS');
  });
  it('refuses non-draft ranges and unknown ranges', async () => {
    setCtx(['source_authority.activate']); mockDb('active'); expect((await post(xlsx(good as never))).status).toBe(409);
    mocks.query.mockReset(); mocks.query.mockResolvedValue({ rows: [] }); expect((await post(xlsx(good as never))).status).toBe(404);
  });
});
