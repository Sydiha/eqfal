import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// G6-1 Zakat readiness workflow over real HTTP + PostgreSQL (disposable DATABASE_URL only).
// Final Zakat payable calculation stays blocked: these tests never expect a payable amount.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('Zakat worksheet G6-1 (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  const doc = async (co: string, uploader: string) => (await h.q<{ id: string }>(
    "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type) VALUES($1,$2,'e.pdf','application/pdf',10,$3,$4,'uploaded','purchase') RETURNING id",
    [co, uploader, `k-${randomUUID()}`, randomBytes(32).toString('hex')]))[0]!.id;

  async function setup(label: string, opts: { start?: string; end?: string; tax?: string; workpaper?: boolean } = {}) {
    const owner = await h.user(`${label}-own`);
    const co = await h.company(label, owner.id);
    await owner.client.login();
    const start = opts.start ?? '2026-01-01', end = opts.end ?? '2026-12-31';
    const fy = await h.fiscalYear(co, 'FY', start, end);
    await h.q(`INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,prepared_by_user_id,approved_by_user_id,approved_at)
      VALUES($1,1,'approved','IFRS','SAR','SAR','2023-01-01','not_registered',$3,'saudi_gcc_only','not_currently_applicable','no','2023-01-01',$2,$2,NOW())`, [co, owner.id, opts.tax ?? 'zakat_applicable']);
    const cash = await h.account(co, 'Z-CASH', 'asset', 'current_asset');
    const fixed = await h.account(co, 'Z-FIX', 'asset', 'non_current_asset');
    const capital = await h.account(co, 'Z-CAP', 'equity', 'equity');
    const loan = await h.account(co, 'Z-LOAN', 'liability', 'non_current_liability');
    const rev = await h.account(co, 'Z-REV', 'revenue', 'revenue');
    await h.postedJournal(co, fy, `${start.slice(0, 4)}-01-15`, owner.id, [[cash, '1000.00', '0'], [capital, '0', '700.00'], [loan, '0', '300.00']]);
    await h.postedJournal(co, fy, `${start.slice(0, 4)}-02-15`, owner.id, [[fixed, '500.00', '0'], [rev, '0', '500.00']]);
    if (opts.workpaper !== false) expect((await owner.client.req('POST', `/tax-working-papers/${fy}`, {})).status).toBe(201);
    const partner = (await h.q<{ id: string }>('INSERT INTO partners(company_id,name,created_by_user_id) VALUES($1,$2,$3) RETURNING id', [co, 'Partner A', owner.id]))[0]!.id;
    const period = (pct: string, status = 'confirmed', pid = partner) => h.q('INSERT INTO partner_ownership_periods(company_id,partner_id,ownership_percentage,effective_from,verification_status,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6)', [co, pid, pct, '2023-01-01', status, owner.id]);
    return { owner, co, fy, cash, fixed, capital, loan, rev, partner, period, url: `/zakat-worksheets/${fy}` };
  }
  type T = Awaited<ReturnType<typeof setup>>;
  const create = (t: T, declared = true) => t.owner.client.req('POST', t.url, { non_financing_entity_declared: declared });
  const get = async (t: T) => (await t.owner.client.req('GET', t.url)).json;
  const eligible = async (t: T, cls = 'saudi_natural', extra: Record<string, unknown> = {}) =>
    t.owner.client.req('POST', '/zakat-eligibility', { partner_id: t.partner, ownership_class: cls, effective_from: '2023-01-01', evidence_document_id: await doc(t.co, t.owner.id), ...extra });
  const act = async (t: T, path: string, body: Record<string, unknown> = {}) => { const v = (await get(t)).worksheet.version; return t.owner.client.req('POST', `${t.url}/${path}`, { version: v, ...body }); };

  /** Drives a worksheet to a fully classified, qualified, draft-ready state. */
  async function ready(label: string) {
    const t = await setup(label);
    await t.period('100.0000');
    expect((await eligible(t)).status).toBe(201);
    expect((await create(t)).status).toBe(201);
    const evidence = await doc(t.co, t.owner.id);
    for (const [acc, cls, art] of [[t.fixed, 'deduction_fixed_assets', 'م26(4)'], [t.loan, 'addition_non_current_liability', 'م29(1)']] as const) {
      const w = (await get(t)).worksheet;
      expect((await t.owner.client.req('PUT', `${t.url}/classifications/${acc}`, { zakat_class: cls, reg_article: art, evidence_document_id: evidence, version: w.version })).status).toBe(200);
    }
    for (const acc of [t.cash, t.fixed, t.capital, t.loan]) expect((await act(t, `classifications/${acc}/confirm`)).status).toBe(200);
    return { t, evidence };
  }

  it('rejects unsupported scope: no workpaper, missing declaration, FY before 2024, non-12-month year, non-zakat path', async () => {
    const noWp = await setup('s1', { workpaper: false });
    expect((await create(noWp)).json.code).toBe('ZAKAT_WORKPAPER_REQUIRED');
    const t = await setup('s2');
    expect((await create(t, false)).status).toBe(422);
    const old = await setup('s3', { start: '2023-01-01', end: '2023-12-31' });
    const r = await create(old);
    expect(r.status).toBe(422); expect(r.json.blockers).toContain('fiscal_year_before_2024');
    const short = await setup('s4', { start: '2026-01-01', end: '2026-06-30' });
    expect((await create(short)).json.blockers).toContain('fiscal_year_not_12_months');
    const income = await setup('s5', { tax: 'income_tax_applicable' });
    expect((await create(income)).json.blockers).toContain('tax_path_not_zakat');
  });

  it('never infers eligibility: no eligibility record or unconfirmed/short ownership gives explicit reasons and blocks review', async () => {
    const t = await setup('o1');
    await t.period('100.0000');
    expect((await create(t)).status).toBe(201);
    let w = await get(t);
    expect(w.worksheet.ownership_snapshot.qualified).toBe(false);
    expect(w.worksheet.ownership_snapshot.reasons).toContain('partner_eligibility_missing');
    expect(w.calculation.status).toBe('blocked'); expect(w.calculation.payable_amount).toBeNull();
    const submit = await act(t, 'submit-review');
    expect(submit.status).toBe(422); expect(submit.json.blockers).toContain('ownership_not_qualified');
    // partner class "other" does not qualify; entity classes need a note; evidence is mandatory
    expect((await eligible(t, 'saudi_entity_confirmed')).status).toBe(422);
    expect((await t.owner.client.req('POST', '/zakat-eligibility', { partner_id: t.partner, ownership_class: 'saudi_natural', effective_from: '2023-01-01' })).status).toBe(400);
    const other = await eligible(t, 'other'); expect(other.status).toBe(201);
    expect((await act(t, 'refresh')).json.worksheet.ownership_snapshot.reasons).toContain('partner_not_qualifying');
    expect((await eligible(t, 'gcc_natural')).json.code).toBe('ZAKAT_ELIGIBILITY_OVERLAP');
    expect((await t.owner.client.req('POST', `/zakat-eligibility/${other.json.eligibility.id}/revoke`, { version: 1, reason: 'wrong class' })).status).toBe(200);
    expect((await eligible(t, 'gcc_natural')).status).toBe(201);
    expect((await act(t, 'refresh')).json.worksheet.ownership_snapshot.qualified).toBe(true);
    // 60% only, plus an unconfirmed period => explicit reasons
    await h.q("UPDATE partner_ownership_periods SET ownership_percentage=60 WHERE company_id=$1", [t.co]);
    await t.period('10.0000', 'unconfirmed');
    const reasons = (await act(t, 'refresh')).json.worksheet.ownership_snapshot.reasons;
    expect(reasons).toEqual(expect.arrayContaining(['ownership_total_not_100', 'unconfirmed_ownership_period']));
  });

  it('requires accountant-confirmed classifications with article/evidence, then runs the full review workflow without a payable amount', async () => {
    const t = await setup('c1');
    await t.period('100.0000'); await eligible(t); await create(t);
    let w = (await get(t)).worksheet;
    expect(w.classifications.every((k: any) => k.status === 'suggested')).toBe(true);
    let r = await act(t, 'submit-review');
    expect(r.json.blockers).toEqual(expect.arrayContaining(['unconfirmed_classification']));
    // category mismatch and missing article are rejected
    const bad = await t.owner.client.req('PUT', `${t.url}/classifications/${t.capital}`, { zakat_class: 'deduction_fixed_assets', reg_article: 'م26', version: w.version });
    expect(bad.json.code).toBe('ZAKAT_CLASS_CATEGORY_MISMATCH');
    expect((await t.owner.client.req('PUT', `${t.url}/classifications/${t.capital}`, { zakat_class: 'addition_equity', reg_article: '  ', version: w.version })).status).toBe(400);
    // evidence-bound class cannot be confirmed without a document
    await t.owner.client.req('PUT', `${t.url}/classifications/${t.fixed}`, { zakat_class: 'deduction_fixed_assets', reg_article: 'م26(4)', version: w.version });
    expect((await act(t, `classifications/${t.fixed}/confirm`)).json.code).toBe('ZAKAT_EVIDENCE_REQUIRED');
    // stale version
    expect((await t.owner.client.req('POST', `${t.url}/classifications/${t.cash}/confirm`, { version: 1 })).json.code).toBe('ZAKAT_STALE_VERSION');
    const evidence = await doc(t.co, t.owner.id);
    w = (await get(t)).worksheet;
    await t.owner.client.req('PUT', `${t.url}/classifications/${t.fixed}`, { zakat_class: 'deduction_fixed_assets', reg_article: 'م26(4)', evidence_document_id: evidence, version: w.version });
    for (const acc of [t.cash, t.fixed, t.capital, t.loan]) expect((await act(t, `classifications/${acc}/confirm`)).status).toBe(200);
    // adjustment requires article and evidence; unresolved professional review blocks
    const adjBody = { description: 'Non-deductible fines', direction: 'add', amount: '10.00', reg_article: 'م62', evidence_document_id: evidence, professional_review_required: true };
    expect((await act(t, 'adjustments', { ...adjBody, evidence_document_id: undefined })).status).toBe(400);
    expect((await act(t, 'adjustments', adjBody)).status).toBe(201);
    expect((await act(t, 'submit-review')).json.blockers).toContain('professional_review_unresolved');
    const adjId = (await get(t)).worksheet.adjustments[0].id;
    const w2 = (await get(t)).worksheet;
    expect((await t.owner.client.req('PATCH', `${t.url}/adjustments/${adjId}`, { professional_review_required: false, version: w2.version })).status).toBe(200);
    expect((await act(t, 'submit-review')).status).toBe(200);
    // content is frozen outside draft
    const frozen = await act(t, 'adjustments', adjBody); expect(frozen.status).toBe(409);
    expect((await act(t, 'review')).status).toBe(200);
    const ret = await act(t, 'return-to-draft', {}); expect(ret.status).toBe(400);
    expect((await act(t, 'return-to-draft', { reason: 'check inventory' })).json.worksheet.status).toBe('draft');
    await act(t, 'submit-review'); await act(t, 'review');
    const approved = await act(t, 'approve');
    expect(approved.status).toBe(200);
    const final = approved.json.worksheet;
    expect(final.status).toBe('approved'); expect(final.approved_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(approved.json.calculation.status).toBe('blocked');
    const snap = (await h.q<{ approved_snapshot: any }>('SELECT approved_snapshot FROM zakat_worksheet_revisions WHERE id=$1', [final.id]))[0]!.approved_snapshot;
    expect(snap.calculation).toMatchObject({ status: 'blocked', payable_amount: null });
    expect(JSON.stringify(snap)).not.toMatch(/payable_amount":"/);
    expect(snap.balances.book_net_profit).toBe('500.00');
    expect(snap.adjustment_totals).toEqual({ add: '10.00', deduct: '0.00' });
    expect(snap.classifications.find((k: any) => k.code === 'Z-FIX')).toMatchObject({ zakat_class: 'deduction_fixed_assets', balance_halalas: '50000' });
    // audit trail
    for (const action of ['zakat_worksheet.create', 'zakat_worksheet.classification.confirm', 'zakat_worksheet.adjustment.create', 'zakat_worksheet.approve', 'zakat_worksheet.return_to_draft', 'zakat_ownership_snapshot.capture', 'zakat_eligibility.record'])
      expect(await h.count('SELECT COUNT(*) n FROM audit_log WHERE company_id=$1 AND action=$2', [t.co, action])).toBeGreaterThan(0);
  });

  it('preserves approved revisions: mandatory reason, supersession only on approval, DB immutability', async () => {
    const { t } = await ready('r1');
    for (const a of ['submit-review', 'review', 'approve']) expect((await act(t, a)).status).toBe(200);
    const first = (await get(t)).worksheet;
    expect((await t.owner.client.req('POST', `${t.url}/revisions`, { version: first.version })).status).toBe(400);
    expect((await t.owner.client.req('POST', `${t.url}/revisions`, { version: first.version, reason: ' ' })).status).toBe(400);
    const rev = await t.owner.client.req('POST', `${t.url}/revisions`, { version: first.version, reason: 'Correct loan classification' });
    expect(rev.status).toBe(201);
    expect(rev.json.worksheet).toMatchObject({ revision_no: 2, status: 'draft', revision_reason: 'Correct loan classification' });
    expect(rev.json.revisions.map((r: any) => [r.revision_no, r.status])).toEqual([[2, 'draft'], [1, 'approved']]);
    expect(rev.json.worksheet.classifications.filter((k: any) => k.status === 'confirmed')).toHaveLength(4); // carried forward, not silently re-opened
    expect((await t.owner.client.req('POST', `${t.url}/revisions`, { version: first.version, reason: 'again' })).json.code).toBe('ZAKAT_REVISION_IN_PROGRESS');
    // approved row cannot be edited or deleted, even directly
    await expect(h.q("UPDATE zakat_worksheet_revisions SET approved_snapshot='{}'::jsonb WHERE id=$1", [first.id])).rejects.toThrow(/immutable/);
    await expect(h.q('DELETE FROM zakat_worksheet_revisions WHERE id=$1', [first.id])).rejects.toThrow(/cannot be deleted/);
    await expect(h.q("UPDATE zakat_revision_classifications SET note='x' WHERE revision_id=$1", [first.id])).rejects.toThrow(/immutable/);
    await expect(h.q('UPDATE zakat_ownership_snapshots SET qualified=FALSE WHERE company_id=$1', [t.co])).rejects.toThrow();
    for (const a of ['submit-review', 'review', 'approve']) expect((await act(t, a)).status).toBe(200);
    const after = await get(t);
    expect(after.revisions.map((r: any) => [r.revision_no, r.status])).toEqual([[2, 'approved'], [1, 'superseded']]);
    expect((await h.q<{ approved_fingerprint: string }>('SELECT approved_fingerprint FROM zakat_worksheet_revisions WHERE id=$1', [first.id]))[0]!.approved_fingerprint).toBe(first.approved_fingerprint);
  });

  it('detects source drift after review and returns the worksheet to draft on refresh', async () => {
    const { t } = await ready('d1');
    expect((await act(t, 'submit-review')).status).toBe(200);
    await h.postedJournal(t.co, t.fy, '2026-03-01', t.owner.id, [[t.cash, '50.00', '0'], [t.capital, '0', '50.00']]);
    expect((await get(t)).worksheet.source_drift).toBe(true);
    const r = await act(t, 'review');
    expect(r.status).toBe(422); expect(r.json.blockers).toContain('balance_source_drift');
    const refreshed = await act(t, 'refresh');
    expect(refreshed.json.worksheet.status).toBe('draft'); expect(refreshed.json.worksheet.source_drift).toBe(false);
  });

  it('enforces permissions and tenant isolation', async () => {
    const { t } = await ready('p1');
    const viewer = await h.user('p1-view'); await h.member(t.co, viewer.id, ['tax_workpaper.view']); await viewer.client.login();
    const editor = await h.user('p1-edit'); await h.member(t.co, editor.id, ['tax_workpaper.view', 'tax_workpaper.edit', 'tax_workpaper.submit']); await editor.client.login();
    const nobody = await h.user('p1-none'); await h.member(t.co, nobody.id, ['partner.view']); await nobody.client.login();
    expect((await viewer.client.req('GET', t.url)).status).toBe(200);
    expect((await nobody.client.req('GET', t.url)).status).toBe(403);
    const v = (await get(t)).worksheet.version;
    expect((await viewer.client.req('POST', `${t.url}/refresh`, { version: v })).status).toBe(403);
    expect((await editor.client.req('POST', `${t.url}/classifications/${t.cash}/confirm`, { version: v })).status).toBe(403);
    expect((await editor.client.req('POST', '/zakat-eligibility', { partner_id: t.partner })).status).toBe(403);
    expect((await editor.client.req('POST', `${t.url}/submit-review`, { version: v })).status).toBe(200);
    expect((await editor.client.req('POST', `${t.url}/review`, { version: v + 1 })).status).toBe(403);
    expect((await editor.client.req('POST', `${t.url}/approve`, { version: v + 1 })).status).toBe(403);
    // another company cannot see, change or revoke this company's data
    const other = await setup('p1x');
    expect((await other.owner.client.req('GET', t.url)).status).toBe(404);
    expect((await other.owner.client.req('POST', `${t.url}/refresh`, { version: v })).status).toBe(404);
    const eligId = (await get(t)).eligibility[0].id;
    expect((await other.owner.client.req('POST', `/zakat-eligibility/${eligId}/revoke`, { version: 1, reason: 'x' })).status).toBe(404);
    expect((await other.owner.client.req('POST', '/zakat-eligibility', { partner_id: t.partner, ownership_class: 'saudi_natural', effective_from: '2023-01-01', evidence_document_id: await doc(other.co, other.owner.id) })).status).toBe(404);
    expect((await other.owner.client.req('POST', '/zakat-eligibility', { partner_id: other.partner, ownership_class: 'saudi_natural', effective_from: '2023-01-01', evidence_document_id: await doc(t.co, t.owner.id) })).status).toBe(422);
  });

  it('feeds the approved snapshot into the annual closing readiness and package summary without changing companies that have no worksheet', async () => {
    const { AnnualClosingService } = await import('../src/modules/annual-closing/annual-closing.service');
    const plain = await setup('a0');
    const none = (await new AnnualClosingService(h.db).readiness(plain.co, plain.fy)).domains['zakat']!;
    expect(none.summary).not.toHaveProperty('zakat_worksheet_fingerprint');
    const { t } = await ready('a1');
    await h.q("UPDATE tax_working_papers SET workflow_status='approved' WHERE company_id=$1", [t.co]); // legacy workpaper state is independent of the worksheet
    const before = (await new AnnualClosingService(h.db).readiness(t.co, t.fy)).domains['zakat']!;
    expect(String(before.summary['blockers'])).toContain('zakat_worksheet_not_approved');
    expect(before.blocker_count).toBe(none.blocker_count); // the worksheet never adds a hard close blocker
    for (const a of ['submit-review', 'review', 'approve']) await act(t, a);
    const approved = (await get(t)).worksheet;
    const after = (await new AnnualClosingService(h.db).readiness(t.co, t.fy)).domains['zakat']!;
    expect(after.summary).toMatchObject({ zakat_worksheet_revision_no: 1, zakat_worksheet_fingerprint: approved.approved_fingerprint, zakat_calculation_status: 'blocked' });
    expect(String(after.summary['blockers'])).not.toContain('zakat_worksheet_not_approved');
    expect(after.blocker_count).toBe(none.blocker_count);
    // a later ledger change surfaces as drift but still does not block the close
    await h.postedJournal(t.co, t.fy, '2026-04-01', t.owner.id, [[t.cash, '5.00', '0'], [t.capital, '0', '5.00']]);
    const drifted = (await new AnnualClosingService(h.db).readiness(t.co, t.fy)).domains['zakat']!;
    expect(String(drifted.summary['blockers'])).toContain('zakat_worksheet_source_drift');
    expect(drifted.blocker_count).toBe(none.blocker_count);
  });
});
