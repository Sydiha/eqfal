import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// Closed fiscal year over real HTTP + PostgreSQL (disposable DATABASE_URL only): VAT review and adjustment writes answer 409 with a stable code
// (never a 500), write nothing, and the same calls still succeed in an open year. Another company's user gets 404, not the closed-year answer.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('VAT writes in a closed fiscal year (PostgreSQL, HTTP)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  async function setup(label: string) {
    const owner = await h.user(`${label}-own`);
    const viewer = await h.user(`${label}-vw`);
    const id = await h.company(label, owner.id);
    await h.member(id, viewer.id, ['vat.view']);
    await owner.client.login(); await viewer.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const doc = (await h.q<{ id: string }>(
      "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount) VALUES($1,$2,'p.pdf','application/pdf',10,$3,$4,'approved','purchase','2026-03-05','100.00') RETURNING id",
      [id, owner.id, `k-${randomUUID()}`, randomUUID().replace(/-/g, '').padEnd(64, '0')]))[0]!.id;
    return { id, fy, owner, viewer, doc };
  }
  type Co = Awaited<ReturnType<typeof setup>>;
  const closeYear = (co: Co) => h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [co.fy]);
  const review = (co: Co, client = co.owner.client) => client.req('PUT', `/documents/${co.doc}/vat-review`, { tax_date: '2026-03-10', review_status: 'pending' });
  const reviews = (co: Co) => h.count('SELECT COUNT(*) n FROM document_vat_reviews WHERE company_id=$1', [co.id]);

  it('VAT review: 409 FISCAL_YEAR_CLOSED with nothing written; the open year still saves', async () => {
    const open = await setup('rvopen');
    expect((await review(open)).status).toBe(200);
    const co = await setup('rvclosed');
    await closeYear(co);
    const res = await review(co);
    expect([res.status, res.json.code]).toEqual([409, 'FISCAL_YEAR_CLOSED']);
    expect(await reviews(co)).toBe(0);
  });

  it('VAT review: permission and tenant isolation come before the closed-year answer', async () => {
    const co = await setup('rviso');
    const other = await setup('rviso2');
    await closeYear(co);
    expect((await review(co, co.viewer.client)).status).toBe(403);
    expect((await other.owner.client.req('PUT', `/documents/${co.doc}/vat-review`, { tax_date: '2026-03-10', review_status: 'pending' })).status).toBe(404);
    expect(await reviews(co)).toBe(0);
  });

  it('VAT adjustment create: 409 FISCAL_YEAR_CLOSED, nothing written; allowed in an open year', async () => {
    async function withAdjustmentFixture(label: string) {
      const co = await setup(label);
      const orig = (await h.q<{ id: string }>("INSERT INTO vat_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-01-01','2026-01-31','open') RETURNING id", [co.id, co.fy]))[0]!.id;
      const adj = (await h.q<{ id: string }>("INSERT INTO vat_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-02-01','2026-02-28','open') RETURNING id", [co.id, co.fy]))[0]!.id;
      const rev = (await h.q<{ id: string }>("INSERT INTO document_vat_reviews(company_id,document_id,review_status,tax_date,treatment,taxable_amount,vat_amount,recoverability_status,recoverable_vat_amount,reviewed_by_user_id,reviewed_at) VALUES($1,$2,'reviewed','2026-01-10','standard',100,15,'fully_recoverable',15,$3,NOW()) RETURNING id", [co.id, co.doc, co.owner.id]))[0]!.id;
      await h.q("UPDATE vat_periods SET status='closed' WHERE id=$1", [orig]);
      const body = { document_vat_review_id: rev, original_vat_period_id: orig, adjustment_vat_period_id: adj, adjustment_type: 'late_document', reason: 'late invoice', taxable_amount_delta: '10.00', vat_amount_delta: '1.50', recoverable_vat_amount_delta: '1.50' };
      return { co, body };
    }
    const open = await withAdjustmentFixture('adjopen');
    const ok = await open.co.owner.client.req('POST', '/vat-adjustments', open.body);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    const closed = await withAdjustmentFixture('adjclosed');
    await closeYear(closed.co);
    const res = await closed.co.owner.client.req('POST', '/vat-adjustments', closed.body);
    expect([res.status, res.json.code]).toEqual([409, 'FISCAL_YEAR_CLOSED']);
    expect(await h.count('SELECT COUNT(*) n FROM vat_adjustments WHERE company_id=$1', [closed.co.id])).toBe(0);
  });
});
