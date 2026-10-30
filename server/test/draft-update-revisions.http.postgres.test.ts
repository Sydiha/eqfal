import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// G7: stale-write protection for document intake, journal draft/line replacement and fixed-asset draft edits (real HTTP + PostgreSQL).
// Requires an isolated, disposable database (DATABASE_URL).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('draft update revisions (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  type Owner = Awaited<ReturnType<Awaited<ReturnType<typeof startHarness>>['user']>>;
  type Co = { id: string; owner: Owner; fy: string; a: string; b: string; category: string };
  let A: Co; let B: Co;
  let viewer: Owner;

  async function setup(label: string): Promise<Co> {
    const owner = await h.user(`${label}-own`);
    const id = await h.company(label, owner.id);
    await owner.client.login();
    const fy = await h.fiscalYear(id, 'FY', '2026-01-01', '2026-12-31');
    const a = await h.account(id, 'R-A', 'asset', 'current_asset');
    const b = await h.account(id, 'R-B', 'revenue', 'revenue');
    const category = (await h.q<{ id: string }>("SELECT id FROM asset_categories WHERE company_id=$1 AND code='machinery_equipment'", [id]))[0]!.id;
    return { id, owner, fy, a, b, category };
  }
  const doc = async (c: Co) => (await h.q<{ id: string }>(
    "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type) VALUES($1,$2,'d.pdf','application/pdf',10,$3,$4,'uploaded','purchase') RETURNING id",
    [c.id, c.owner.id, `k-${randomUUID()}`, randomBytes(32).toString('hex')]))[0]!.id;
  const draftJournal = async (c: Co) => (await c.owner.client.req('POST', '/journals', { fiscal_year_id: c.fy, accounting_date: '2026-03-01', description: 'draft' })).json.id as string;
  const draftAsset = async (c: Co) => (await h.q<{ id: string }>(
    `INSERT INTO fixed_assets(company_id,asset_category_id,name,source_type,manual_reason,source_reference,acquisition_cost,acquisition_date,placed_in_service_date,depreciation_start_date,useful_life_months,residual_value,opening_accumulated_depreciation,depreciation_method,status,created_by)
     VALUES($1,$2,'Asset','manual_opening','r','ref',1000,'2026-01-01','2026-01-01','2026-01-01',60,0,0,'straight_line','draft',$3) RETURNING id`, [c.id, c.category, c.owner.id]))[0]!.id;
  const rev = (v: number | string) => ({ 'if-match': String(v) });
  const lines = (c: Co, memo: string) => ({ lines: [{ account_id: c.a, debit: '10.00', credit: '0', memo }, { account_id: c.b, debit: '0', credit: '10.00', memo }] });

  beforeAll(async () => {
    h = await startHarness();
    A = await setup('rv-a'); B = await setup('rv-b');
    viewer = await h.user('rv-view');
    await h.member(A.id, viewer.id, ['document.view', 'accounting.view', 'asset.view']);
    await viewer.client.login();
  });
  afterAll(() => h.close());

  describe('document intake', () => {
    it('exactly one of two concurrent edits from the same revision succeeds; the stale one changes nothing', async () => {
      const id = await doc(A);
      const listed = (await A.owner.client.req('GET', '/documents')).json.documents.find((d: { id: string }) => d.id === id);
      const v = listed.version as number;
      expect(v).toBe(1);
      const [r1, r2] = await Promise.all([
        A.owner.client.req('PATCH', `/documents/${id}/intake`, { total_amount: 111 }, rev(v)),
        A.owner.client.req('PATCH', `/documents/${id}/intake`, { total_amount: 222 }, rev(v)),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      const loser = r1.status === 409 ? r1 : r2; const winner = r1.status === 200 ? r1 : r2;
      expect(loser.json.code).toBe('DOCUMENT_VERSION_CONFLICT');
      const row = (await h.q<{ total_amount: string; version: number }>('SELECT total_amount::text,version FROM documents WHERE id=$1', [id]))[0]!;
      expect(Number(row.total_amount)).toBe(Number(winner.json.document.total_amount));
      expect(row.version).toBe(2);
    });
    it('a fresh revision succeeds, a stale one is rejected without writing, a missing or malformed one is explicit', async () => {
      const id = await doc(A);
      const ok = await A.owner.client.req('PATCH', `/documents/${id}/intake`, { total_amount: 50 }, rev(1));
      expect(ok.status).toBe(200); expect(ok.json.document.version).toBe(2);
      const stale = await A.owner.client.req('PATCH', `/documents/${id}/intake`, { total_amount: 99 }, rev(1));
      expect(stale.status).toBe(409); expect(stale.json.code).toBe('DOCUMENT_VERSION_CONFLICT');
      expect(Number((await h.q<{ t: string }>('SELECT total_amount::text t FROM documents WHERE id=$1', [id]))[0]!.t)).toBe(50);
      const fresh = await A.owner.client.req('PATCH', `/documents/${id}/intake`, { total_amount: 60 }, rev(2));
      expect(fresh.status).toBe(200);
      const missing = await A.owner.client.req('PATCH', `/documents/${id}/intake`, { total_amount: 70 });
      expect(missing.status).toBe(428); expect(missing.json.code).toBe('REVISION_REQUIRED');
      const bad = await A.owner.client.req('PATCH', `/documents/${id}/intake`, { total_amount: 70 }, rev('abc'));
      expect(bad.status).toBe(400); expect(bad.json.code).toBe('REVISION_INVALID');
      expect(Number((await h.q<{ t: string }>('SELECT total_amount::text t FROM documents WHERE id=$1', [id]))[0]!.t)).toBe(60);
    });
    it('enforces tenant isolation and permission', async () => {
      const id = await doc(A);
      expect((await B.owner.client.req('PATCH', `/documents/${id}/intake`, { total_amount: 1 }, rev(1))).status).toBe(404);
      expect((await viewer.client.req('PATCH', `/documents/${id}/intake`, { total_amount: 1 }, rev(1))).status).toBe(403);
      expect(Number((await h.q<{ v: number }>('SELECT version v FROM documents WHERE id=$1', [id]))[0]!.v)).toBe(1);
    });
  });

  describe('journal draft', () => {
    it('line replacement: one concurrent winner, stale rejected with no change, fresh revision succeeds', async () => {
      const id = await draftJournal(A);
      const v = (await A.owner.client.req('GET', `/journals/${id}`)).json.version as number;
      const [r1, r2] = await Promise.all([
        A.owner.client.req('PUT', `/journals/${id}/lines`, lines(A, 'one'), rev(v)),
        A.owner.client.req('PUT', `/journals/${id}/lines`, lines(A, 'two'), rev(v)),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      expect((r1.status === 409 ? r1 : r2).json.code).toBe('JOURNAL_VERSION_CONFLICT');
      const winner = r1.status === 200 ? r1 : r2;
      const memos = (await h.q<{ memo: string }>('SELECT DISTINCT memo FROM journal_lines WHERE journal_entry_id=$1', [id])).map((r) => r.memo);
      expect(memos).toHaveLength(1);
      expect(winner.json.version).toBe(v + 1);
      const after = (await A.owner.client.req('GET', `/journals/${id}`)).json.version as number;
      expect(after).toBe(v + 1);
      const stale = await A.owner.client.req('PUT', `/journals/${id}/lines`, lines(A, 'late'), rev(v));
      expect(stale.status).toBe(409);
      expect((await h.q<{ memo: string }>('SELECT DISTINCT memo FROM journal_lines WHERE journal_entry_id=$1', [id])).map((r) => r.memo)).toEqual(memos);
      expect((await A.owner.client.req('PUT', `/journals/${id}/lines`, lines(A, 'fresh'), rev(after))).status).toBe(200);
    });
    it('header edit uses the same revision; missing revision is explicit; a stale edit after line replacement is rejected', async () => {
      const id = await draftJournal(A);
      expect((await A.owner.client.req('PUT', `/journals/${id}/lines`, lines(A, 'x'), rev(1))).status).toBe(200);
      const stale = await A.owner.client.req('PATCH', `/journals/${id}`, { description: 'stale' }, rev(1));
      expect(stale.status).toBe(409); expect(stale.json.code).toBe('JOURNAL_VERSION_CONFLICT');
      expect((await A.owner.client.req('PATCH', `/journals/${id}`, { description: 'nope' })).status).toBe(428);
      const ok = await A.owner.client.req('PATCH', `/journals/${id}`, { description: 'fresh' }, rev(2));
      expect(ok.status).toBe(200);
      expect((await h.q<{ d: string }>('SELECT description d FROM journal_entries WHERE id=$1', [id]))[0]!.d).toBe('fresh');
    });
    it('posting still works on a fresh draft and tenant/permission checks hold', async () => {
      const id = await draftJournal(A);
      await A.owner.client.req('PUT', `/journals/${id}/lines`, lines(A, 'p'), rev(1));
      expect((await B.owner.client.req('PUT', `/journals/${id}/lines`, lines(B, 'x'), rev(2))).status).toBe(404);
      expect((await viewer.client.req('PUT', `/journals/${id}/lines`, lines(A, 'x'), rev(2))).status).toBe(403);
      expect((await A.owner.client.req('POST', `/journals/${id}/post`, {})).status).toBe(200);
    });
  });

  describe('fixed-asset draft', () => {
    it('one concurrent winner, stale rejected with no change, fresh succeeds', async () => {
      const id = await draftAsset(A);
      const v = (await A.owner.client.req('GET', `/assets/${id}`)).json.version as number;
      const [r1, r2] = await Promise.all([
        A.owner.client.req('PATCH', `/assets/${id}`, { name: 'First' }, rev(v)),
        A.owner.client.req('PATCH', `/assets/${id}`, { name: 'Second' }, rev(v)),
      ]);
      expect([r1.status, r2.status], JSON.stringify([r1.json, r2.json])).toEqual(expect.arrayContaining([200]));
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      expect((r1.status === 409 ? r1 : r2).json.code).toBe('FIXED_ASSET_VERSION_CONFLICT');
      const name = (await h.q<{ n: string }>('SELECT name n FROM fixed_assets WHERE id=$1', [id]))[0]!.n;
      expect(name).toBe(r1.status === 200 ? 'First' : 'Second');
      expect((await A.owner.client.req('PATCH', `/assets/${id}`, { name: 'Late' }, rev(v))).status).toBe(409);
      expect((await h.q<{ n: string }>('SELECT name n FROM fixed_assets WHERE id=$1', [id]))[0]!.n).toBe(name);
      expect((await A.owner.client.req('PATCH', `/assets/${id}`, { name: 'Fresh' }, rev(v + 1))).status).toBe(200);
      expect((await A.owner.client.req('PATCH', `/assets/${id}`, { name: 'None' })).status).toBe(428);
    });
    it('enforces tenant isolation and permission', async () => {
      const id = await draftAsset(A);
      expect((await B.owner.client.req('PATCH', `/assets/${id}`, { name: 'x' }, rev(1))).status).toBe(404);
      expect((await viewer.client.req('PATCH', `/assets/${id}`, { name: 'x' }, rev(1))).status).toBe(403);
    });
  });
});
