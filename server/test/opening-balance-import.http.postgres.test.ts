import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { ACCOUNTANT_CAPABILITIES } from '../src/modules/memberships/default-role-capabilities';

// T7.2: draft-only opening-balance bulk import over real HTTP + PostgreSQL: concurrency, retries, rollback, isolation. Requires a disposable DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('opening-balance import (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  async function setup(label: string, fyStatus = 'open') {
    const owner = await h.user(`${label}-own`);
    const accountant = await h.user(`${label}-acc`);
    const id = await h.company(label, owner.id);
    await h.member(id, accountant.id, [...ACCOUNTANT_CAPABILITIES]);
    await accountant.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31', fyStatus);
    const bank = await h.account(id, `B${label}`, 'asset', 'current_asset');
    const capital = await h.account(id, `C${label}`, 'equity', 'equity');
    const other = await h.company(`${label}-x`, owner.id);
    const foreign = await h.account(other, `F${label}`, 'asset', 'current_asset');
    return { id, fy, accountant, bank, capital, foreign };
  }
  type Co = Awaited<ReturnType<typeof setup>>;
  const body = (co: Co, o: { account?: string; credit?: string } = {}) => ({ confirm: true, file_name: 'ob.xlsx', items: [
    { row: 2, account_id: o.account ?? co.bank, debit: '1234567.89', credit: '0.00', category: 'bank', partner_id: null },
    { row: 3, account_id: co.capital, debit: '0.00', credit: o.credit ?? '1234567.89', category: 'equity', partner_id: null },
  ] });
  const imp = (co: Co, b: unknown) => co.accountant.client.req('POST', `/opening-balances/${co.fy}/import`, b);
  const counts = async (co: Co) => ({
    reviews: await h.count('SELECT COUNT(*)::text n FROM opening_balance_reviews WHERE company_id=$1', [co.id]),
    items: await h.count('SELECT COUNT(*)::text n FROM opening_balance_items WHERE company_id=$1', [co.id]),
    journals: await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1', [co.id]),
  });

  it('two simultaneous imports with no existing review: exactly one succeeds, one review, no duplicate rows', async () => {
    const co = await setup('obiConc');
    const results = await Promise.all([imp(co, body(co)), imp(co, body(co))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.json.code).toBe('IMPORT_DRAFT_NOT_EMPTY');
    expect(await counts(co)).toEqual({ reviews: 1, items: 2, journals: 0 });
  });

  it('a retry after a successful import is rejected and adds nothing; items stay draft with exact amounts, never approved or posted', async () => {
    const co = await setup('obiRetry');
    expect((await imp(co, body(co))).status).toBe(201);
    const again = await imp(co, body(co));
    expect(again.status).toBe(409); expect(again.json.code).toBe('IMPORT_DRAFT_NOT_EMPTY');
    expect(await counts(co)).toEqual({ reviews: 1, items: 2, journals: 0 });
    const review = (await h.q<{ status: string; journal_entry_id: string | null }>('SELECT status,journal_entry_id FROM opening_balance_reviews WHERE company_id=$1', [co.id]))[0]!;
    expect(review).toEqual({ status: 'draft', journal_entry_id: null });
    const items = await h.q<{ amount: string; balance_side: string; source_type: string }>('SELECT amount::text,balance_side,source_type FROM opening_balance_items WHERE company_id=$1 ORDER BY balance_side', [co.id]);
    expect(items).toEqual([{ amount: '1234567.89', balance_side: 'credit', source_type: 'internal_ledger' }, { amount: '1234567.89', balance_side: 'debit', source_type: 'internal_ledger' }]);
  });

  it('a failed batch rolls back atomically, including the review it would have created', async () => {
    const co = await setup('obiRollback');
    const foreign = await imp(co, body(co, { account: co.foreign }));
    expect(foreign.status).toBe(400); expect(foreign.json.code).toBe('TB_ACCOUNT_UNMATCHED');
    const unbalanced = await imp(co, body(co, { credit: '1234567.88' }));
    expect(unbalanced.status).toBe(400); expect(unbalanced.json.code).toBe('TB_UNBALANCED');
    expect(await counts(co)).toEqual({ reviews: 0, items: 0, journals: 0 });
    expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action LIKE 'opening_balance%'", [co.id])).toBe(0);
    expect((await imp(co, body(co))).status).toBe(201);
  });

  it('refuses a closed fiscal year and a non-empty manual draft without touching existing items', async () => {
    const closed = await setup('obiClosed', 'closed');
    expect((await imp(closed, body(closed))).json.code).toBe('FISCAL_YEAR_CLOSED');
    expect(await counts(closed)).toEqual({ reviews: 0, items: 0, journals: 0 });
    const co = await setup('obiManual');
    const manual = await co.accountant.client.req('POST', `/opening-balances/${co.fy}/items`, { category: 'bank', account_id: co.bank, amount: '5.00', balance_side: 'debit', source_type: 'original_document', confidence: 'high' });
    expect(manual.status).toBe(201);
    expect((await imp(co, body(co))).json.code).toBe('IMPORT_DRAFT_NOT_EMPTY');
    expect(await counts(co)).toEqual({ reviews: 1, items: 1, journals: 0 });
  });
});
