import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// G6-1 Zakat preparation workflow (real PostgreSQL, disposable DATABASE_URL only): eligibility evidence, ownership/balances snapshots,
// accountant-confirmed classifications, revisions, permissions, tenant isolation, audit, immutability and the annual package summary.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;
const BLOCKING_GATES = ['B0_amendment_1248', 'B3_rounding', 'B4_cap_ordering', 'B7_book_profit_after_zakat', 'B9_reference_cases_approval'];

describeDatabase('zakat worksheet G6-1 (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let Svc: typeof import('../src/modules/zakat-worksheets/zakat-worksheet.service');
  let seq = 0;

  beforeAll(async () => {
    h = await startHarness();
    Svc = await import('../src/modules/zakat-worksheets/zakat-worksheet.service');
  });
  afterAll(async () => {
    await h.q("UPDATE zakat_regulatory_gates SET status='unverified', verified_by_name=NULL, verified_on=NULL, verification_reference=NULL");
    h.close();
  });

  const verifyGates = () => h.q(`UPDATE zakat_regulatory_gates SET status='verified', verified_by_name='Test Accountant', verified_on=CURRENT_DATE, verification_reference='test-fixture' WHERE code = ANY($1)`, [BLOCKING_GATES]);
  const resetGates = () => h.q("UPDATE zakat_regulatory_gates SET status='unverified', verified_by_name=NULL, verified_on=NULL, verification_reference=NULL");

  async function setup(label: string, opts: { start?: string; end?: string; ownershipContext?: string; pct?: string } = {}) {
    const n = ++seq;
    const owner = await h.user(`z${n}-${label}`);
    const co = await h.company(`z${n}${label}`, owner.id);
    await owner.client.login();
    const start = opts.start ?? '2025-01-01', end = opts.end ?? '2025-12-31';
    const fy = await h.fiscalYear(co, 'FY', start, end);
    const cap = await h.account(co, 'Z-CAP', 'equity', 'equity');
    const fa = await h.account(co, 'Z-FA', 'asset', 'non_current_asset');
    const cash = await h.account(co, 'Z-CASH', 'asset', 'current_asset');
    const ncl = await h.account(co, 'Z-NCL', 'liability', 'non_current_liability');
    await h.postedJournal(co, fy, start, owner.id, [[fa, '600.00', '0'], [cash, '400.00', '0'], [cap, '0', '800.00'], [ncl, '0', '200.00']]);
    const partner = (await h.q<{ id: string }>('INSERT INTO partners(company_id,name,created_by_user_id) VALUES($1,$2,$3) RETURNING id', [co, 'Partner One', owner.id]))[0]!.id;
    await h.q(`INSERT INTO partner_ownership_periods(company_id,partner_id,ownership_percentage,effective_from,verification_status,created_by_user_id) VALUES($1,$2,$3,$4,'confirmed',$5)`, [co, partner, opts.pct ?? '100', start, owner.id]);
    const doc = (await h.q<{ id: string }>(`INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256) VALUES($1,$2,'id.pdf','application/pdf',10,$3,$4) RETURNING id`, [co, owner.id, `k-${co}`, 'a'.repeat(64)]))[0]!.id;
    await h.q(`INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,prepared_by_user_id,reviewed_by_user_id,reviewed_at,approved_by_user_id,approved_at,change_reason)
      VALUES($1,1,'approved','IFRS','SAR','SAR',$2,'not_registered','zakat_applicable',$3,'not_currently_applicable','no',$2,$4,$4,now(),$4,now(),'fixture')`, [co, start, opts.ownershipContext ?? 'saudi_gcc_only', owner.id]);
    return { co, owner, fy, cap, fa, cash, ncl, partner, doc, start };
  }
  type T = Awaited<ReturnType<typeof setup>>;

  const eligible = async (t: T, cls = 'saudi_natural') => {
    const created = await t.owner.client.req('POST', '/zakat-eligibility', { partner_id: t.partner, ownership_class: cls, effective_from: t.start, evidence_document_id: t.doc });
    expect(created.status).toBe(201);
    const confirmed = await t.owner.client.req('POST', `/zakat-eligibility/${created.json.eligibility.id}/confirm`, { version: created.json.eligibility.version });
    expect(confirmed.status).toBe(200);
    return confirmed.json.eligibility;
  };
  const get = async (t: T) => (await t.owner.client.req('GET', `/zakat-worksheets/${t.fy}`)).json;
  const post = (t: T, path: string, body: unknown, method = 'POST') => t.owner.client.req(method, `/zakat-worksheets/${t.fy}${path}`, body);
  const classifyAll = async (t: T) => {
    const plan: [string, string, string][] = [[t.cap, 'equity_capital', 'Art. 23(1)'], [t.fa, 'deductible_fixed_asset', 'Art. 49'], [t.cash, 'non_deductible_asset', 'Art. 26'], [t.ncl, 'non_current_liability', 'Art. 29(1)']];
    for (const [acc, type, art] of plan) {
      const w = (await get(t)).worksheet;
      const r = await post(t, `/classifications/${acc}`, { zakat_type: type, reg_article: art, version: w.version }, 'PUT');
      expect(r.status).toBe(200);
    }
  };
  const prepare = async (t: T) => {
    await eligible(t);
    expect((await post(t, '', {})).status).toBe(201);
    const w = (await get(t)).worksheet;
    expect((await post(t, '/declarations', { non_financing_confirmed: true, accounting_records_confirmed: true, version: w.version }, 'PATCH')).status).toBe(200);
    await classifyAll(t);
  };
  const act = async (t: T, name: string, extra: object = {}) => post(t, `/${name}`, { version: (await get(t)).worksheet.version, ...extra });
  const audit = (co: string, action: string) => h.count('SELECT COUNT(*) n FROM audit_log WHERE company_id=$1 AND action=$2', [co, action]);

  const adminFor = async (t: T) => {
    const admin = await h.user(`zakat-admin-${++seq}`);
    await h.member(t.co, admin.id, ['zakat.reviewer.manage']);
    await admin.client.login();
    return admin;
  };
  const appointReviewer = async (t: T, admin: Awaited<ReturnType<typeof adminFor>>, reviewer: Awaited<ReturnType<typeof h.user>>, reference: string) =>
    admin.client.req('POST', '/zakat-reviewers', { user_id: reviewer.id, appointment_reference: reference, identity_verified: true });
  const decisionsPath = '/regulatory-decisions';
  const gateFacts = (t: T, period: Record<string, string> = { activityPeriod: 'regular' }) => ({
    B0: { projects: [], deductibleAssets: [{ accountId: t.fa, amountSar: '600.00' }], undeductedAssets: [{ accountId: t.cash, amountSar: '400.00' }] },
    B3: { ...period, rounding: 'HALF_UP' },
    B4: { liabilityReclassifications: [], lossReconciliations: [] },
    B7: { charges: [], adjustments: [] },
    B9: {},
  });
  const reviewerFor = async (t: T) => {
    const reviewer = await h.user(`zakat-review-${++seq}`);
    await h.member(t.co, reviewer.id, ['tax_workpaper.view', 'tax_workpaper.approve', 'document.view']);
    await h.q('INSERT INTO zakat_regulatory_reviewers(company_id,user_id,appointment_reference,appointed_by_user_id,identity_verified_at) VALUES($1,$2,$3,$4,now())', [t.co, reviewer.id, 'disposable integration fixture appointment', t.owner.id]);
    await reviewer.client.login();
    return (path: string, body: unknown) => reviewer.client.req('POST', `/zakat-worksheets/${t.fy}${path}`, body);
  };
  const submitDecision = async (t: T, gate: string, facts: object, extra: object = {}) => {
    return post(t, decisionsPath, {
      version: (await get(t)).worksheet.version, gate, evidence_document_id: t.doc,
      authority_reference: 'disposable integration fixture', facts, ...extra,
    });
  };
  const attest = async (t: T, facts: Record<string, object> = gateFacts(t), review?: Awaited<ReturnType<typeof reviewerFor>>) => {
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [t.fy]);
    await h.q("UPDATE documents SET status='approved' WHERE id=$1", [t.doc]);
    const reviewer = review ?? await reviewerFor(t);
    for (const [gate, details] of Object.entries(facts)) {
      expect(await submitDecision(t, gate, details)).toMatchObject({ status: 204 });
      const decision = (await get(t)).regulatory_decisions.find((d: { gate: string }) => d.gate === gate);
      expect(await reviewer(`${decisionsPath}/${decision.id}/approve`, {})).toMatchObject({ status: 204 });
    }
    return () => get(t).then((d) => reviewer('/approve', { version: d.worksheet.version }));
  };

  it('never infers eligibility: missing, unconfirmed, non-qualifying and non-100% ownership are specific blockers', async () => {
    const t = await setup('own');
    let g = await get(t);
    expect(g.ownership_live.qualified).toBe(false);
    expect(g.ownership_live.blockers).toContain('partner_eligibility_missing');
    const row = (await t.owner.client.req('POST', '/zakat-eligibility', { partner_id: t.partner, ownership_class: 'saudi_natural', effective_from: t.start, evidence_document_id: t.doc })).json.eligibility;
    expect((await get(t)).ownership_live.blockers).toContain('partner_eligibility_unconfirmed');
    await t.owner.client.req('DELETE', `/zakat-eligibility/${row.id}`, { version: row.version });
    await eligible(t, 'unknown');
    expect((await get(t)).ownership_live.blockers).toContain('partner_class_not_qualifying');

    const split = await setup('split', { pct: '60' });
    await eligible(split);
    expect((await get(split)).ownership_live.blockers).toContain('ownership_total_not_100');

    const mixed = await setup('mixed', { ownershipContext: 'includes_non_saudi' });
    await eligible(mixed);
    expect((await get(mixed)).ownership_live.blockers).toContain('profile_ownership_context_not_saudi_gcc');

    const ok = await setup('okown');
    await eligible(ok);
    const live = (await get(ok)).ownership_live;
    expect(live).toMatchObject({ qualified: true, blockers: [], as_of_date: '2025-12-31', total_ownership_bps4: '1000000' });
  });

  it('requires evidence documents, entity notes and keeps confirmed eligibility rows immutable and non-overlapping', async () => {
    const t = await setup('elig');
    const bad = await t.owner.client.req('POST', '/zakat-eligibility', { partner_id: t.partner, ownership_class: 'saudi_natural', effective_from: t.start });
    expect(bad.status).toBe(400);
    const noNote = await t.owner.client.req('POST', '/zakat-eligibility', { partner_id: t.partner, ownership_class: 'gcc_entity', effective_from: t.start, evidence_document_id: t.doc });
    expect(noNote.status).toBe(400); expect(noNote.json.code).toBe('ZAKAT_ENTITY_NOTE_REQUIRED');
    const row = await eligible(t);
    await expect(h.q("UPDATE zakat_ownership_eligibility SET ownership_class='gcc_natural' WHERE id=$1", [row.id])).rejects.toThrow(/immutable/);
    await expect(h.q('DELETE FROM zakat_ownership_eligibility WHERE id=$1', [row.id])).rejects.toThrow(/cannot be deleted/);
    const second = (await t.owner.client.req('POST', '/zakat-eligibility', { partner_id: t.partner, ownership_class: 'gcc_natural', effective_from: t.start, evidence_document_id: t.doc })).json.eligibility;
    const overlap = await t.owner.client.req('POST', `/zakat-eligibility/${second.id}/confirm`, { version: second.version });
    expect(overlap.status).toBe(409);
    const noReason = await t.owner.client.req('POST', `/zakat-eligibility/${row.id}/end`, { version: row.version, effective_to: '2025-06-30' });
    expect(noReason.status).toBe(400);
    await expect(h.q("UPDATE zakat_ownership_eligibility SET effective_to='2025-06-30' WHERE id=$1", [row.id])).rejects.toThrow(/requires a reason/);
    const ended = await t.owner.client.req('POST', `/zakat-eligibility/${row.id}/end`, { version: row.version, effective_to: '2025-06-30', reason: 'Ownership transferred' });
    expect(ended.status).toBe(200);
    expect(await audit(t.co, 'zakat_eligibility.end')).toBe(1);
    expect((await h.q('SELECT reason FROM audit_log WHERE company_id=$1 AND action=$2', [t.co, 'zakat_eligibility.end']))[0].reason).toBe('Ownership transferred');
    await expect(h.q("UPDATE zakat_ownership_eligibility SET end_reason='changed' WHERE id=$1", [row.id])).rejects.toThrow(/immutable/);
    expect((await get(t)).ownership_live.blockers).toContain('partner_eligibility_unconfirmed');
    expect(await audit(t.co, 'zakat_eligibility.confirm')).toBeGreaterThan(0);
  });

  it('rejects unsupported fiscal periods and captures balances only from classified statement categories', async () => {
    const pre = await setup('pre2024', { start: '2023-01-01', end: '2023-12-31' });
    const r = await post(pre, '', {});
    expect(r.status).toBe(400); expect(r.json.code).toBe('ZAKAT_UNSUPPORTED_SCOPE');
    const short = await setup('short', { start: '2025-01-01', end: '2025-06-30' });
    expect((await post(short, '', {})).status).toBe(201);

    const t = await setup('bal');
    expect((await post(t, '', {})).status).toBe(201);
    const ws = (await get(t)).worksheet;
    const byCode = Object.fromEntries(ws.balances_snapshot.accounts.map((a: { code: string; amount_cents: string }) => [a.code, a.amount_cents]));
    expect(byCode).toMatchObject({ 'Z-CAP': '80000', 'Z-FA': '60000', 'Z-CASH': '40000', 'Z-NCL': '20000' });
    expect(ws.balances_snapshot.as_of_date).toBe('2025-12-31');
    expect((await post(t, '', {})).status).toBe(409);
  });

  it('runs draft -> in_review -> reviewed, but approval stays blocked until the blocking regulatory gates are verified; no amount is produced', async () => {
    await resetGates();
    const t = await setup('flow');
    await prepare(t);
    let g = await get(t);
    expect(g.readiness).toMatchObject({ preparation_blockers: [], can_submit: true, can_approve: false, calculation_performed: false, payable_amount: null, payable_amount_status: 'withheld_regulatory_gates' });
    expect(g.readiness.gate_blockers).toEqual([...BLOCKING_GATES].sort());
    expect((await act(t, 'submit')).status).toBe(200);
    expect((await act(t, 'review')).status).toBe(200);
    await verifyGates();
    const blocked = await act(t, 'approve');
    await resetGates();
    expect(blocked.status).toBe(409); expect(blocked.json.code).toBe('ZAKAT_REGULATORY_GATES_UNVERIFIED');
    expect((await get(t)).worksheet.status).toBe('reviewed');
    // edits are rejected outside draft, at the API and at the database
    const w = (await get(t)).worksheet;
    expect((await post(t, `/classifications/${t.cash}`, { zakat_type: 'non_deductible_asset', reg_article: 'x', version: w.version }, 'PUT')).json.code).toBe('ZAKAT_WORKSHEET_NOT_DRAFT');
    await expect(h.q('UPDATE zakat_account_classifications SET reg_article=$2 WHERE worksheet_id=$1', [w.id, 'tamper'])).rejects.toThrow(/locked/);
    // return to draft needs a reason
    expect((await act(t, 'return', {})).status).toBe(400);
    const back = await act(t, 'return', { reason: 'fix evidence' });
    expect(back.status).toBe(200); expect(back.json.worksheet.status).toBe('draft');
    expect(await audit(t.co, 'zakat_worksheet.return_to_draft')).toBe(1);
  });

  it('releases an exact payable only after independent approval, and requires fresh decisions on revision', async () => {
    await verifyGates();
    try {
      const t = await setup('rev');
      await prepare(t);
      await act(t, 'submit'); await act(t, 'review');
      const approve = await attest(t);
      expect((await get(t)).finalization).toMatchObject({ status: 'BLOCKED', payable_amount_halalas: null });
      const { calculateApprovedZakatBase: directBeforeApproval } = await import('../src/modules/zakat-calculation/zakat-base-engine');
      const beforeApprovalClient = await h.db.connect();
      try {
        await beforeApprovalClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const reviewed = (await get(t)).worksheet;
        expect(await directBeforeApproval(beforeApprovalClient, t.co, t.fy, reviewed.id, t.owner.id)).toMatchObject({
          status: 'BLOCKED', payableAmountHalalas: null, exemptionCode: null,
        });
      } finally {
        await beforeApprovalClient.query('ROLLBACK'); beforeApprovalClient.release();
      }
      expect((await act(t, 'approve')).status).toBe(403);
      const approved = await approve();
      expect(approved.status).toBe(200);
      const a1 = approved.json.worksheet;
      expect(a1).toMatchObject({ status: 'approved', revision_no: 1 });
      expect(a1.approved_snapshot).toMatchObject({ calculation_performed: true, payable_amount: null, revision_no: 1 });
      expect(approved.json.finalization).toMatchObject({ status: 'READY', payable_amount_halalas: '1031' });
      // A direct server-module call cannot replace persisted amounts or decisions with caller values.
      const { calculateApprovedZakatBase } = await import('../src/modules/zakat-calculation/zakat-base-engine');
      const direct = calculateApprovedZakatBase as unknown as (...args: unknown[]) => Promise<{ status: string; payableAmountHalalas: string | null }>;
      const client = await h.db.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        for (const forged of [
          { sourceBalances: [{ amountSar: '999999999.00' }] },
          { currentEarningsHalalas: 999999999n },
          { classifications: [{ zakat_type: 'equity_capital' }] },
          { fiscalPeriod: { endDate: '2025-06-30', activityPeriod: 'cessation' } },
          { finalRounding: 'DOWN' },
          { regulatoryDecisionReferences: [{ gate: 'B9', disposition: 'decision_recorded' }] },
        ]) {
          const result = await direct(client, t.co, t.fy, a1.id, null, forged);
          expect(result).toMatchObject({ status: 'READY', payableAmountHalalas: '1031' });
        }
      } finally {
        await client.query('ROLLBACK'); client.release();
      }
      expect(a1.approved_snapshot_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      await expect(h.q("UPDATE zakat_worksheets SET notes_never=1 WHERE id=$1", [a1.id])).rejects.toThrow();
      await expect(h.q("UPDATE zakat_worksheets SET non_financing_confirmed=false WHERE id=$1", [a1.id])).rejects.toThrow(/immutable/);
      await expect(h.q('DELETE FROM zakat_worksheets WHERE id=$1', [a1.id])).rejects.toThrow(/cannot be deleted/);

      expect((await post(t, '/revise', { version: a1.version })).status).toBe(400);
      const revised = await post(t, '/revise', { version: a1.version, reason: 'Corrected classification of cash' });
      expect(revised.status).toBe(201);
      const r2 = revised.json.worksheet;
      expect(r2).toMatchObject({ revision_no: 2, status: 'draft', revision_reason: 'Corrected classification of cash', supersedes_id: a1.id });
      expect(revised.json.classifications).toHaveLength(4);
      expect((await post(t, '/revise', { version: a1.version, reason: 'again' })).status).toBe(409);
      // the approved revision is untouched while revision 2 is a draft
      expect((await h.q<{ status: string }>('SELECT status FROM zakat_worksheets WHERE id=$1', [a1.id]))[0]!.status).toBe('approved');

      await act(t, 'submit'); await act(t, 'review');
      expect((await act(t, 'approve')).status).toBe(409);
      const approveRevision = await attest(t);
      const a2 = await approveRevision();
      expect(a2.status).toBe(200); expect(a2.json.worksheet.revision_no).toBe(2);
      const rows = await h.q<{ revision_no: number; status: string }>('SELECT revision_no,status FROM zakat_worksheets WHERE company_id=$1 AND fiscal_year_id=$2 ORDER BY revision_no', [t.co, t.fy]);
      expect(rows).toEqual([{ revision_no: 1, status: 'superseded' }, { revision_no: 2, status: 'approved' }]);
      expect((await get(t)).revisions.map((r: { revision_no: number }) => r.revision_no)).toEqual([2, 1]);
      for (const action of ['create', 'submit', 'review', 'approve', 'revise', 'classification.confirm']) expect(await audit(t.co, `zakat_worksheet.${action}`)).toBeGreaterThan(0);
    } finally { await resetGates(); }
  });

  it('detects source drift in balances and ownership, requires a refresh, and reports drift to the annual package summary', async () => {
    await verifyGates();
    try {
      const t = await setup('drift');
      await prepare(t);
      await act(t, 'submit'); await act(t, 'review');
      const approve = await attest(t);
      expect(await approve()).toMatchObject({ status: 200 });
      const s = new Svc.ZakatWorksheetService(h.db);
      expect(await s.packageSummary(t.co, t.fy, h.db, true)).toMatchObject({ revision_no: 1, source_drift: false });
      await h.postedJournal(t.co, t.fy, '2025-03-01', t.owner.id, [[t.cash, '10.00', '0'], [t.cap, '0', '10.00']]);
      expect(await s.packageSummary(t.co, t.fy, h.db, true)).toMatchObject({ source_drift: true });
      expect((await get(t)).finalization).toMatchObject({ status: 'BLOCKED', payable_amount_halalas: null });
      expect((await s.packageSummary(t.co, t.fy, h.db, false))!.source_drift).toBe(false);
      // a revision picks up the new balance; the changed account must be (re)confirmed only if it was dropped
      const w = (await get(t)).worksheet;
      const rev = await post(t, '/revise', { version: w.version, reason: 'New posting' });
      expect(rev.json.readiness.preparation_blockers).toEqual([]);
      const cap = rev.json.worksheet.balances_snapshot.accounts.find((a: { code: string }) => a.code === 'Z-CAP');
      expect(cap.amount_cents).toBe('81000');
      // ownership drift: a new unconfirmed period appears
      await h.q(`INSERT INTO partner_ownership_periods(company_id,partner_id,ownership_percentage,effective_from,verification_status,created_by_user_id) VALUES($1,$2,10,'2025-02-01','unconfirmed',$3)`, [t.co, t.partner, t.owner.id]);
      const g = await get(t);
      expect(g.readiness.preparation_blockers).toEqual(expect.arrayContaining(['ownership_source_drift', 'unconfirmed_ownership_period']));
      expect((await act(t, 'submit')).status).toBe(400);
    } finally { await resetGates(); }
  });

  it('rejects fabricated approval, self-review, foreign evidence, and unappointed or unauthenticated reviewers', async () => {
    const t = await setup('trust');
    const other = await setup('foreign');
    await prepare(t);
    await act(t, 'submit'); await act(t, 'review');
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [t.fy]);
    await h.q("UPDATE documents SET status='approved' WHERE id=ANY($1::uuid[])", [[t.doc, other.doc]]);
    expect((await submitDecision(t, 'B9', {}, { evidence_document_id: other.doc })).status).toBe(400);
    expect((await submitDecision(t, 'B9', {}, { reviewed_by: other.owner.id })).status).toBe(400);
    expect((await submitDecision(t, 'B9', { reviewAttestation: { reviewerReference: other.owner.id } })).status).toBe(400);
    expect((await submitDecision(t, 'B9', {})).status).toBe(204);
    const decision = (await get(t)).regulatory_decisions[0];
    const path = `${decisionsPath}/${decision.id}/approve`;
    const unappointed = await h.user('zakat-unappointed');
    await h.member(t.co, unappointed.id, ['tax_workpaper.view', 'tax_workpaper.approve', 'document.view']);
    const url = `/zakat-worksheets/${t.fy}${path}`;
    expect((await unappointed.client.req('POST', url, {})).status).toBe(401);
    await unappointed.client.login();
    expect((await unappointed.client.req('POST', url, {})).status).toBe(403);
    await prepare(other);
    await act(other, 'submit'); await act(other, 'review');
    expect((await post(other, path, {})).status).toBe(404);
    const viewOnly = await h.user('zakat-appointed-view-only');
    await h.member(t.co, viewOnly.id, ['tax_workpaper.view', 'document.view']);
    await h.q('INSERT INTO zakat_regulatory_reviewers(company_id,user_id,appointment_reference,appointed_by_user_id,identity_verified_at) VALUES($1,$2,$3,$4,now())', [t.co, viewOnly.id, 'fixture without approval capability', t.owner.id]);
    await viewOnly.client.login();
    expect((await viewOnly.client.req('POST', url, {})).status).toBe(403);
    expect((await unappointed.client.req('POST', url, {}, { origin: 'https://example.test' })).status).toBe(403);
    await h.q('INSERT INTO zakat_regulatory_reviewers(company_id,user_id,appointment_reference,appointed_by_user_id,identity_verified_at) VALUES($1,$2,$3,$4,now())', [t.co, t.owner.id, 'fixture self-review attempt', viewOnly.id]);
    expect((await post(t, path, {})).status).toBe(403);
    const reviewer = await reviewerFor(t);
    expect((await reviewer(path, { reviewed_by: t.owner.id })).status).toBe(400);
    expect((await reviewer(path, {})).status).toBe(204);
    expect((await get(t)).regulatory_decisions[0]).toMatchObject({ status: 'verified', submitted_by: t.owner.id });
    expect(await audit(t.co, 'zakat_regulatory_decision.approve')).toBe(1);
    await expect(h.q('DELETE FROM zakat_regulatory_decisions WHERE id=$1', [decision.id])).rejects.toThrow(/immutable/);
    await expect(h.q('TRUNCATE zakat_regulatory_decisions')).rejects.toThrow(/immutable/);
    expect((await get(t)).finalization).toMatchObject({ status: 'BLOCKED', payable_amount_halalas: null });
  });

  it('requires dedicated appointment administration and keeps old approvals invalid after revoke and reappointment', async () => {
    const t = await setup('appointment-identity');
    await prepare(t);
    await act(t, 'submit'); await act(t, 'review');
    const reviewer = await h.user(`zakat-review-reappoint-${++seq}`);
    await h.member(t.co, reviewer.id, ['tax_workpaper.view', 'tax_workpaper.approve', 'document.view']);
    await reviewer.client.login();
    const admin = await adminFor(t);
    const denied = await t.owner.client.req('GET', '/zakat-reviewers');
    expect(denied.status).toBe(403);
    const targetRole = (await h.q<{ id: string }>('INSERT INTO roles(company_id,name) VALUES($1,$2) RETURNING id', [t.co, 'reviewer-manager-copy-attempt']))[0]!.id;
    const { MembershipService } = await import('../src/modules/memberships/membership.service');
    await expect(new MembershipService(h.db).changeRoleCapability(targetRole, 'zakat.reviewer.manage', t.co, admin.id, true))
      .rejects.toMatchObject({ code: 'ACCESS_SYSTEM_ADMIN_REQUIRED' });
    const firstResponse = await appointReviewer(t, admin, reviewer, 'appointment reference one');
    expect(firstResponse.status).toBe(201);
    const firstId = firstResponse.json.appointment_id as string;
    const reviewerPost = (path: string, body: unknown) => reviewer.client.req('POST', `/zakat-worksheets/${t.fy}${path}`, body);
    const approveWorksheet = await attest(t, gateFacts(t), reviewerPost);
    expect((await approveWorksheet()).json.finalization).toMatchObject({ status: 'READY', payable_amount_halalas: '1031' });
    const before = await get(t);
    expect(before.regulatory_decisions).toHaveLength(5);
    expect(before.regulatory_decisions.every((row: { reviewer_appointment_id: string }) => row.reviewer_appointment_id === firstId)).toBe(true);

    const revoked = await admin.client.req('POST', `/zakat-reviewers/${firstId}/revoke`, { reason: 'Appointment term ended' });
    expect(revoked.status).toBe(200);
    const secondResponse = await appointReviewer(t, admin, reviewer, 'appointment reference two');
    expect(secondResponse.status).toBe(201);
    expect(secondResponse.json.appointment_id).not.toBe(firstId);
    const after = await get(t);
    expect(after.regulatory_decisions.every((row: { status: string; reviewer_appointment_id: string }) => row.status === 'stale' && row.reviewer_appointment_id === firstId)).toBe(true);
    expect(after.finalization).toMatchObject({ status: 'BLOCKED', payable_amount_halalas: null });
    expect(await audit(t.co, 'zakat.reviewer.appoint')).toBe(2);
    expect(await audit(t.co, 'zakat.reviewer.revoke')).toBe(1);
  });

  it('reconciles B7 charges to posted expense accounts before releasing payable', async () => {
    const t = await setup('recorded-charge');
    const revenue = await h.account(t.co, 'Z-REVENUE', 'revenue', 'revenue');
    const expense = await h.account(t.co, 'Z-CHARGE', 'expense', 'other_expense');
    await h.postedJournal(t.co, t.fy, t.start, t.owner.id,
      [[t.cash, '25.00', '0'], [revenue, '0', '25.00'], [expense, '15.00', '0'], [t.cash, '0', '15.00']]);
    await prepare(t);
    await act(t, 'submit'); await act(t, 'review');
    const reviewer = await reviewerFor(t);
    const facts = gateFacts(t);
    facts.B0.undeductedAssets[0]!.amountSar = '410.00';
    const charges = (amountSar: string) => ({
      charges: [{ accountId: expense, kind: 'zakat_provision', amountSar }], adjustments: [],
      currentEarningsTreatment: 'include_in_equity',
    });
    const approve = await attest(t, { ...facts, B7: charges('14.99') }, reviewer);
    expect((await approve()).status).toBe(409);
    expect((await get(t)).finalization).toMatchObject({ status: 'BLOCKED', blockers: ['RECORDED_CHARGE_LEDGER_MISMATCH'], payable_amount_halalas: null });
    const b7 = () => get(t).then((d) => d.regulatory_decisions.find((item: { gate: string; status: string }) => item.gate === 'B7' && item.status !== 'ended'));
    expect((await reviewer(`${decisionsPath}/${(await b7()).id}/end`, { reason: 'Correct the recorded charge amount' })).status).toBe(204);
    expect((await submitDecision(t, 'B7', charges('15.00'))).status).toBe(204);
    expect((await reviewer(`${decisionsPath}/${(await b7()).id}/approve`, {})).status).toBe(204);
    expect((await approve()).json.finalization).toMatchObject({ status: 'READY', payable_amount_halalas: '1057' });
  });

  it('keeps a short period blocked without confirmed cessation and withdraws an exemption after revocation', async () => {
    const t = await setup('cessation', { end: '2025-06-30' });
    await prepare(t);
    await act(t, 'submit'); await act(t, 'review');
    const reviewer = await reviewerFor(t);
    const approve = await attest(t, gateFacts(t, { activityPeriod: 'cessation', activityDate: '2025-06-29' }), reviewer);
    expect((await approve()).status).toBe(409);
    expect((await get(t)).finalization.blockers).toContain('ARTICLE15_PERIOD_EVIDENCE_MISMATCH');
    const b3 = () => get(t).then((d) => d.regulatory_decisions.find((item: { gate: string; status: string }) => item.gate === 'B3' && item.status !== 'ended'));
    expect((await reviewer(`${decisionsPath}/${(await b3()).id}/end`, { reason: 'Date mismatch' })).status).toBe(204);
    expect((await submitDecision(t, 'B3', { activityPeriod: 'cessation', activityDate: '2025-06-30', rounding: 'HALF_UP' })).status).toBe(204);
    expect((await reviewer(`${decisionsPath}/${(await b3()).id}/approve`, {})).status).toBe(204);
    expect((await approve()).json.finalization).toMatchObject({ status: 'EXEMPT', payable_amount_halalas: null });
    expect((await reviewer(`${decisionsPath}/${(await b3()).id}/end`, { reason: 'Cessation evidence withdrawn' })).status).toBe(204);
    expect((await get(t)).finalization).toMatchObject({ status: 'BLOCKED', payable_amount_halalas: null });
  });

  it('refuses incomplete worksheets: scope declarations, unclassified balances and category-inconsistent or evidence-less classifications', async () => {
    const t = await setup('guard');
    await eligible(t);
    await post(t, '', {});
    let g = await get(t);
    expect(g.readiness.preparation_blockers).toEqual(expect.arrayContaining(['scope_declaration_missing', 'unclassified_balance']));
    const w = g.worksheet;
    const mismatch = await post(t, `/classifications/${t.fa}`, { zakat_type: 'equity_capital', reg_article: 'Art. 23', version: w.version }, 'PUT');
    expect(mismatch.status).toBe(400); expect(mismatch.json.code).toBe('ZAKAT_TYPE_CATEGORY_MISMATCH');
    const noEvidence = await post(t, `/classifications/${t.fa}`, { zakat_type: 'deductible_investment', reg_article: 'Art. 43', version: w.version }, 'PUT');
    expect(noEvidence.json.code).toBe('ZAKAT_EVIDENCE_REQUIRED');
    const noArticle = await post(t, `/classifications/${t.fa}`, { zakat_type: 'deductible_fixed_asset', reg_article: ' ', version: w.version }, 'PUT');
    expect(noArticle.status).toBe(400);
    const stale = await post(t, `/classifications/${t.fa}`, { zakat_type: 'deductible_fixed_asset', reg_article: 'Art. 49', version: w.version + 5 }, 'PUT');
    expect(stale.status).toBe(409);
    const submit = await act(t, 'submit');
    expect(submit.status).toBe(400); expect(submit.json.code).toBe('ZAKAT_NOT_READY');
  });

  it('adjustments need a regulatory article and evidence, are draft-only, and are audited', async () => {
    const t = await setup('adj');
    await eligible(t); await post(t, '', {});
    const v = async () => (await get(t)).worksheet.version;
    const noEvidence = await post(t, '/adjustments', { description: 'Disallowed expense', direction: 'add', amount: '100.00', reg_article: 'Art. 62', version: await v() });
    expect(noEvidence.status).toBe(400); expect(noEvidence.json.code).toBe('ZAKAT_EVIDENCE_REQUIRED');
    expect((await post(t, '/adjustments', { description: 'x', direction: 'add', amount: '100.5', reg_article: 'Art. 62', evidence_note: 'n', version: await v() })).status).toBe(400);
    const added = await post(t, '/adjustments', { description: 'Disallowed expense', direction: 'add', amount: '100.00', reg_article: 'Art. 62', evidence_document_id: t.doc, version: await v() });
    expect(added.status).toBe(201);
    const adj = added.json.adjustments[0];
    const changed = await post(t, `/adjustments/${adj.id}`, { description: 'Disallowed expense v2', direction: 'deduct', amount: '90.00', reg_article: 'Art. 63', evidence_note: 'ledger ref', version: await v(), adjustment_version: adj.version }, 'PATCH');
    expect(changed.status).toBe(200); expect(changed.json.adjustments[0]).toMatchObject({ amount: '90.00', direction: 'deduct', version: 2 });
    expect((await post(t, `/adjustments/${adj.id}`, { description: 'stale', direction: 'add', amount: '1.00', reg_article: 'a', evidence_note: 'n', version: await v(), adjustment_version: 1 }, 'PATCH')).status).toBe(409);
    expect((await post(t, `/adjustments/${adj.id}`, { version: await v() }, 'DELETE')).status).toBe(200);
    expect((await get(t)).adjustments).toHaveLength(0);
    for (const a of ['create', 'update', 'delete']) expect(await audit(t.co, `zakat_worksheet.adjustment.${a}`)).toBe(1);
  });

  it('enforces capabilities and tenant isolation', async () => {
    const t = await setup('perm');
    await eligible(t); await post(t, '', {});
    const viewer = await h.user('zv'); await h.member(t.co, viewer.id, ['tax_workpaper.view']); await viewer.client.login();
    const url = `/zakat-worksheets/${t.fy}`;
    expect((await viewer.client.req('GET', url)).status).toBe(200);
    for (const [method, path, body] of [['POST', url, {}], ['PATCH', `${url}/declarations`, { non_financing_confirmed: true, accounting_records_confirmed: true, version: 1 }], ['POST', `${url}/submit`, { version: 1 }], ['POST', `${url}/review`, { version: 1 }], ['POST', `${url}/approve`, { version: 1 }], ['POST', `${url}/revise`, { version: 1, reason: 'x' }], ['POST', '/zakat-eligibility', {}]] as const) {
      expect((await viewer.client.req(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    const reviewer = await h.user('zr'); await h.member(t.co, reviewer.id, ['tax_workpaper.view', 'tax_workpaper.review']); await reviewer.client.login();
    expect((await reviewer.client.req('POST', `${url}/approve`, { version: 1 })).status).toBe(403);
    const other = await setup('other');
    expect((await other.owner.client.req('GET', url)).status).toBe(404);
    expect((await other.owner.client.req('POST', `${url}/submit`, { version: 1 })).status).toBe(404);
    const foreign = await other.owner.client.req('POST', '/zakat-eligibility', { partner_id: t.partner, ownership_class: 'saudi_natural', effective_from: t.start, evidence_document_id: other.doc });
    expect(foreign.status).toBe(400);
    expect((await other.owner.client.req('GET', '/zakat-eligibility')).json.eligibility).toHaveLength(0);
  });

  it('keeps worksheet creation and approval closed once the annual package is finalized, and adds the summary to zakat readiness only when approved', async () => {
    await verifyGates();
    try {
      const t = await setup('pkg');
      await prepare(t);
      const { taxReadiness } = await import('../src/modules/annual-closing/annual-closing.service');
      const none = taxReadiness('zakat', null, null, 0, null);
      expect(Object.keys(none.summary)).not.toContain('zakat_worksheet_revision');
      await act(t, 'submit'); await act(t, 'review');
      await h.q(`INSERT INTO annual_closing_packages(company_id,fiscal_year_id,status) VALUES($1,$2,'finalized')`, [t.co, t.fy]);
      const closed = await act(t, 'approve');
      expect(closed.status).toBe(409); expect(closed.json.code).toBe('ZAKAT_PACKAGE_FINALIZED');
      const wk = { accounting_profile_id: 'p', tax_path: 'zakat', workflow_status: 'approved', professional_review_required: false, unresolved: 0, source_drift: false };
      const ready = taxReadiness('zakat', 'p', wk, 0, { revision_no: 1, approved_snapshot_fingerprint: 'f'.repeat(64), source_drift: false });
      expect(ready).toMatchObject({ status: 'ready', summary: { zakat_worksheet_revision: 1, zakat_worksheet_snapshot_fingerprint: 'f'.repeat(64) } });
      const drifted = taxReadiness('zakat', 'p', wk, 0, { revision_no: 1, approved_snapshot_fingerprint: 'f'.repeat(64), source_drift: true });
      expect(drifted).toMatchObject({ status: 'blocked', blocker_count: 1 });
      expect(String(drifted.summary['blockers'])).toContain('zakat_worksheet_source_drift');
      expect(taxReadiness('zakat', 'p', wk, 0, null).status).toBe('ready');
    } finally { await resetGates(); }
  });

  it('keeps regulatory gates from being deleted, downgraded or truncated, and flags investments and professional review', async () => {
    await expect(h.q("DELETE FROM zakat_regulatory_gates WHERE code='B9_reference_cases_approval'")).rejects.toThrow(/cannot be deleted/);
    await expect(h.q("UPDATE zakat_regulatory_gates SET blocks_approval=FALSE WHERE code='B3_rounding'")).rejects.toThrow(/stop blocking/);
    await expect(h.q('TRUNCATE zakat_regulatory_gates')).rejects.toThrow(/truncated/);
    await expect(h.q("UPDATE zakat_regulatory_gates SET status='verified' WHERE code='B0_amendment_1248'")).rejects.toThrow();
    const t = await setup('adj9');
    expect((await post(t, '', {})).status).toBe(201);
    const noEvidence = await post(t, '/adjustments', { description: 'x', direction: 'add', amount: '1.00', reg_article: 'Art. 23', version: (await get(t)).worksheet.version, professional_review_required: true });
    expect(noEvidence.json.code).toBe('ZAKAT_EVIDENCE_REQUIRED');
    const ok = await post(t, '/adjustments', { description: 'x', direction: 'add', amount: '1.00', reg_article: 'Art. 23', evidence_note: 'Board minute 4', professional_review_required: true, version: (await get(t)).worksheet.version });
    expect(ok.status).toBe(201);
    expect((await get(t)).adjustments[0].professional_review_required).toBe(true);
    expect(await audit(t.co, 'zakat_worksheet.adjustment.create')).toBe(1);
  });
});
