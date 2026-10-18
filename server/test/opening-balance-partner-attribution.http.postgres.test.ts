import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { ACCOUNTANT_CAPABILITIES, FINANCE_MANAGER_CAPABILITIES } from '../src/modules/memberships/default-role-capabilities';

// T1 / G4: partner attribution of opening capital, current and loan items over real HTTP + PostgreSQL. Requires a disposable DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('opening-balance partner attribution (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  type User = Awaited<ReturnType<Awaited<ReturnType<typeof startHarness>>['user']>>;
  type Co = { id: string; fy: string; owner: User; accountant: User; manager: User; bank: string; capital: string; partner: string; other: string; foreignPartner: string };

  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  async function setup(label: string): Promise<Co> {
    const owner = await h.user(`${label}-own`);
    const accountant = await h.user(`${label}-acc`);
    const manager = await h.user(`${label}-fm`);
    const id = await h.company(label, owner.id);
    await h.member(id, accountant.id, [...ACCOUNTANT_CAPABILITIES]);
    await h.member(id, manager.id, [...FINANCE_MANAGER_CAPABILITIES]);
    for (const x of [owner, accountant, manager]) await x.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const bank = await h.account(id, 'OB-BANK', 'asset', 'current_asset');
    const capital = await h.account(id, 'OB-CAP', 'equity', 'equity');
    const mk = async (company: string, name: string) => (await h.q<{ id: string }>('INSERT INTO partners(company_id,name,created_by_user_id) VALUES($1,$2,$3) RETURNING id', [company, name, owner.id]))[0]!.id;
    const partner = await mk(id, 'Partner A');
    const other = await mk(id, 'Partner B');
    const otherCompany = await h.company(`${label}-x`, owner.id);
    const foreignPartner = await mk(otherCompany, 'Foreign');
    return { id, fy, owner, accountant, manager, bank, capital, partner, other, foreignPartner };
  }
  const item = (co: Co, o: Record<string, unknown>) => ({ category: 'partner_capital', account_id: co.capital, amount: '1000.00', balance_side: 'credit', source_type: 'original_document', confidence: 'high', ...o });
  const post = (co: Co, body: Record<string, unknown>, who: User = co.accountant) => who.client.req('POST', `/opening-balances/${co.fy}/items`, body);

  it('requires a company partner for partner_capital, partner_current and partner_loan', async () => {
    const co = await setup('attrReq');
    for (const category of ['partner_capital', 'partner_current', 'partner_loan']) {
      const missing = await post(co, item(co, { category }));
      expect(missing.status).toBe(400);
      const nullish = await post(co, item(co, { category, partner_id: null }));
      expect(nullish.status).toBe(400);
      const ok = await post(co, item(co, { category, partner_id: co.partner }));
      expect(ok.status).toBe(201);
      expect(ok.json.item.partner_id).toBe(co.partner);
    }
    expect((await post(co, item(co, { partner_id: 'not-a-uuid' }))).status).toBe(400);
    expect((await post(co, item(co, { partner_id: '00000000-0000-4000-8000-000000000000' }))).status).toBe(400);
    expect((await post(co, item(co, { partner_id: co.foreignPartner }))).status).toBe(400);
    expect(await h.count('SELECT COUNT(*)::text n FROM opening_balance_items WHERE company_id=$1', [co.id])).toBe(3);
  });

  it('rejects a partner on non-partner categories and inactive partners; update cannot clear or cross-company the partner', async () => {
    const co = await setup('attrUpd');
    expect((await post(co, item(co, { category: 'bank', account_id: co.bank, balance_side: 'debit', partner_id: co.partner }))).status).toBe(400);
    await h.q('UPDATE partners SET is_active=false WHERE id=$1', [co.other]);
    expect((await post(co, item(co, { partner_id: co.other }))).status).toBe(400);
    const created = (await post(co, item(co, { partner_id: co.partner }))).json.item;
    const patch = (body: Record<string, unknown>) => co.accountant.client.req('PATCH', `/opening-balances/${co.fy}/items/${created.id}`, { version: created.version, ...body });
    expect((await patch({ partner_id: null })).status).toBe(400);
    expect((await patch({ partner_id: co.foreignPartner })).status).toBe(400);
    expect((await patch({ category: 'bank', account_id: co.bank })).status).toBe(400);
    expect((await patch({ partner_id: co.other })).status).toBe(400);
    const moved = await patch({ category: 'partner_loan' });
    expect(moved.status).toBe(200);
    expect(moved.json.item?.partner_id ?? moved.json.partner_id).toBe(co.partner);
    const audits = await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='opening_balance_item.update'", [co.id]);
    expect(audits).toBe(1);
  });

  it('blocks submit and approval for legacy partner items without a partner, without changing the review', async () => {
    const co = await setup('attrLegacy');
    const review = (await h.q<{ id: string }>('INSERT INTO opening_balance_reviews(company_id,fiscal_year_id,prepared_by) VALUES($1,$2,$3) RETURNING id', [co.id, co.fy, co.owner.id]))[0]!.id;
    await h.q("INSERT INTO opening_balance_items(company_id,review_id,category,account_id,amount,balance_side,source_type,confidence,created_by) VALUES($1,$2,'partner_capital',$3,500.00,'credit','internal_ledger','high',$4)", [co.id, review, co.capital, co.owner.id]);
    await h.q("INSERT INTO opening_balance_items(company_id,review_id,category,account_id,amount,balance_side,source_type,confidence,created_by) VALUES($1,$2,'bank',$3,500.00,'debit','internal_ledger','high',$4)", [co.id, review, co.bank, co.owner.id]);
    expect((await co.manager.client.req('POST', `/opening-balances/${co.fy}/submit-review`, {})).status).toBe(400);
    await h.q("UPDATE opening_balance_reviews SET status='in_review',submitted_by=$2,submitted_at=NOW() WHERE id=$1", [review, co.owner.id]);
    expect((await co.manager.client.req('POST', `/opening-balances/${co.fy}/approve`, {})).status).toBe(400);
    const r = (await h.q<{ status: string; journal_entry_id: string | null }>('SELECT status,journal_entry_id FROM opening_balance_reviews WHERE id=$1', [review]))[0]!;
    expect(r).toEqual({ status: 'in_review', journal_entry_id: null });
  });

  it('end to end: attributed item posts one journal, appears once in the partner ledger, and an approved review stays immutable', async () => {
    const co = await setup('attrE2E');
    const cap = (await post(co, item(co, { partner_id: co.partner }))).json.item;
    expect((await post(co, item(co, { category: 'bank', account_id: co.bank, balance_side: 'debit' }))).status).toBe(201);
    expect((await co.manager.client.req('POST', `/opening-balances/${co.fy}/submit-review`, {})).status).toBe(200);
    expect((await co.manager.client.req('POST', `/opening-balances/${co.fy}/approve`, {})).status).toBe(200);
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND entry_type='opening_balance' AND status='posted'", [co.id])).toBe(1);
    const ledger = (await co.owner.client.req('GET', `/partners/${co.partner}/ledger?from=2026-01-01&to=2026-12-31`)).json;
    expect(ledger.classes.capital).toEqual({ opening_balance: '1000.00', increases: '0.00', decreases: '0.00', closing_balance: '1000.00' });
    const otherLedger = (await co.owner.client.req('GET', `/partners/${co.other}/ledger?from=2026-01-01&to=2026-12-31`)).json;
    expect(otherLedger.classes.capital.closing_balance).toBe('0.00');
    // approved data is never reopened or mutated
    const before = (await h.q('SELECT * FROM opening_balance_items WHERE id=$1', [cap.id]))[0];
    const patch = await co.owner.client.req('PATCH', `/opening-balances/${co.fy}/items/${cap.id}`, { version: cap.version, partner_id: co.other });
    expect(patch.status).toBe(409);
    expect((await co.owner.client.req('DELETE', `/opening-balances/${co.fy}/items/${cap.id}`)).status).toBe(409);
    expect((await h.q('SELECT * FROM opening_balance_items WHERE id=$1', [cap.id]))[0]).toEqual(before);
  });
});
