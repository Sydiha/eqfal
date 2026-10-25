import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// C5-P3: historical records services and API (real HTTP + PostgreSQL, disposable DATABASE_URL only).
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('historical records API (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  type U = Awaited<ReturnType<Awaited<ReturnType<typeof startHarness>>['user']>>;
  let ownerA: U, ownerB: U, viewer: U, manager: U, approver: U, nobody: U;
  let A: string, B: string, fyA: string, year = 1990;

  const SHA = 'c'.repeat(64);
  const doc = async (company: string, owner: U) => {
    const id = randomUUID();
    await h.q(`INSERT INTO documents (id, company_id, uploaded_by_user_id, original_filename, mime_type, size_bytes, storage_key, sha256)
               VALUES ($1,$2,$3,'f.pdf','application/pdf',1,$4,$5)`, [id, company, owner.id, `${company}/${id}`, SHA]);
    return id;
  };
  /** A fresh, non-overlapping period for owner A. */
  async function period(client = ownerA.client) {
    year += 1;
    const r = await client.req('POST', '/historical/periods', { label: `P${year}`, period_start: `${year}-01-01`, period_end: `${year}-12-31`, completeness: 'incomplete', reason: 'initial' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.period.id as string;
  }
  const official = (p: string, extra: Record<string, unknown> = {}, client = ownerA.client) => client.req('POST', `/historical/periods/${p}/versions`, {
    kind: 'official', statement_type: 'profit_or_loss', functional_currency: 'SAR', submitted_to: 'Authority', submission_date: '2020-04-30',
    proof_level: 'declared_unverified', ...extra });
  const line = (v: string, code: string, amount: string, extra: Record<string, unknown> = {}, client = ownerA.client) =>
    client.req('POST', `/historical/versions/${v}/lines`, { line_code: code, label_en: code, amount, ...extra });
  const seal = (v: string, client = ownerA.client) => client.req('POST', `/historical/versions/${v}/seal`, { confirm: true });
  async function sealedOfficial(p: string, lines: Array<[string, string]> = [['REV', '1000.00'], ['EXP', '400.00']]) {
    const v = (await official(p)).json.version.id as string;
    for (const [c, a] of lines) expect((await line(v, c, a)).status).toBe(201);
    expect((await seal(v)).status).toBe(200);
    return v;
  }
  const auditActions = (entity: string) => h.q<{ action: string }>('SELECT action FROM audit_log WHERE entity_id=$1 ORDER BY created_at, id', [entity]).then((r) => r.map((x) => x.action));

  beforeAll(async () => {
    h = await startHarness();
    ownerA = await h.user('hA'); ownerB = await h.user('hB'); viewer = await h.user('hV'); manager = await h.user('hM'); approver = await h.user('hP'); nobody = await h.user('hN');
    A = await h.company('hA', ownerA.id); B = await h.company('hB', ownerB.id);
    await h.member(A, viewer.id, ['historical.view']);
    await h.member(A, manager.id, ['historical.view', 'historical.manage']);
    await h.member(A, approver.id, ['historical.view', 'historical.approve']);
    await h.member(A, nobody.id, ['document.view']);
    for (const u of [ownerA, ownerB, viewer, manager, approver, nobody]) await u.client.login();
    fyA = await h.fiscalYear(A, 'FY', '2024-01-01', '2024-12-31');
  });
  afterAll(() => h.close());

  it('rejects anonymous callers and callers without the needed capability', async () => {
    const p = await period();
    expect((await nobody.client.req('GET', '/historical/periods')).status).toBe(403);
    expect((await viewer.client.req('GET', `/historical/periods/${p}`)).status).toBe(200);
    expect((await viewer.client.req('POST', '/historical/periods', { label: 'x', period_start: '1980-01-01', period_end: '1980-12-31', completeness: 'complete', reason: 'r' })).status).toBe(403);
    expect((await viewer.client.req('POST', `/historical/periods/${p}/versions`, {})).status).toBe(403);
    // manage does not include approve; approve does not include manage
    const v = await sealedOfficial(p);
    expect((await manager.client.req('POST', `/historical/versions/${v}/review`, { action: 'review', confirm: true })).status).toBe(403);
    expect((await manager.client.req('POST', `/historical/periods/${p}/reopen-reconstruction`, { reason: 'x', confirm: true })).status).toBe(403);
    expect((await approver.client.req('POST', `/historical/periods/${p}/versions`, {})).status).toBe(403);
    const unauth = await h.user('hAnon');
    expect((await unauth.client.req('GET', '/historical/periods')).status).toBe(401);
  });

  it('keeps companies apart and never trusts a client company id', async () => {
    const p = await period();
    const v = await sealedOfficial(p);
    for (const [m, url, body] of [['GET', `/historical/periods/${p}`], ['GET', `/historical/versions/${v}`], ['GET', `/historical/versions/${v}/history`], ['GET', `/historical/versions/${v}/comparison?against=${v}`],
      ['POST', `/historical/versions/${v}/corrections`, { confirm: true, source_type: 'bank_statement', confidence: 'high' }], ['POST', `/historical/versions/${v}/review`, { action: 'review', confirm: true }],
      ['POST', `/historical/periods/${p}/versions`, { kind: 'official' }], ['PATCH', `/historical/periods/${p}/status`, { completeness: 'complete', reason: 'r' }]] as Array<[string, string, unknown?]>) {
      const r = await ownerB.client.req(m, url, body);
      expect([404, 400], `${m} ${url} -> ${r.status}`).toContain(r.status);
      expect(r.status).not.toBe(200);
    }
    expect((await ownerB.client.req('GET', '/historical/periods')).json.periods).toHaveLength(0);
    const spoof = await ownerB.client.req('POST', '/historical/periods', { company_id: A, label: 'x', period_start: '1970-01-01', period_end: '1970-12-31', completeness: 'complete', reason: 'r' });
    expect(spoof.status).toBe(400);
    const own = await ownerB.client.req('POST', '/historical/periods', { label: 'B', period_start: `${year}-01-01`, period_end: `${year}-12-31`, completeness: 'complete', reason: 'same dates, other company' });
    expect(own.status).toBe(201);
    expect(own.json.period.company_id).toBe(B);
    // a document of the other company cannot be attached
    const foreign = await doc(B, ownerB);
    const r = await official(p, { proof_level: 'proof_attached', proof_document_id: foreign });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('HISTORICAL_DOCUMENT_NOT_FOUND');
  });

  it('creates periods, refuses overlaps, and requires a new reason for every status change', async () => {
    year += 1;
    const base = { label: 'Per', period_start: `${year}-01-01`, period_end: `${year}-12-31`, completeness: 'complete', reason: 'first' };
    const c = await ownerA.client.req('POST', '/historical/periods', base);
    expect(c.status).toBe(201);
    const id = c.json.period.id;
    expect(c.json.period.reconstruction_status).toBe('not_started');
    const overlap = await ownerA.client.req('POST', '/historical/periods', { ...base, period_start: `${year}-06-01`, period_end: `${year + 1}-05-31` });
    expect(overlap.status).toBe(409);
    expect(overlap.json.code).toBe('HISTORICAL_PERIOD_OVERLAP');
    expect((await ownerA.client.req('POST', '/historical/periods', { ...base, period_start: `${year}-12-31`, period_end: `${year + 1}-05-31` })).status).toBe(409);
    expect((await ownerA.client.req('POST', '/historical/periods', { ...base, period_start: '2021-02-30', period_end: '2021-12-31' })).status).toBe(400);
    expect((await ownerA.client.req('POST', '/historical/periods', { ...base, period_start: '2021-12-31', period_end: '2021-01-01' })).status).toBe(400);
    // operational fiscal year (2024) may coexist
    const fyPeriod = await ownerA.client.req('POST', '/historical/periods', { label: 'FY24 view', period_start: '2024-01-01', period_end: '2024-12-31', completeness: 'incomplete', reason: 'coexists' });
    expect(fyPeriod.status).toBe(201);
    // transitions
    expect((await ownerA.client.req('PATCH', `/historical/periods/${id}/status`, { reconstruction_status: 'completed', reason: 'skip' })).status).toBe(409);
    const s1 = await ownerA.client.req('PATCH', `/historical/periods/${id}/status`, { reconstruction_status: 'in_progress', completeness: 'incomplete', reason: 'starting' });
    expect(s1.status, JSON.stringify(s1.json)).toBe(200);
    expect(s1.json.period).toMatchObject({ reconstruction_status: 'in_progress', completeness: 'incomplete', status_reason: 'starting' });
    expect((await ownerA.client.req('PATCH', `/historical/periods/${id}/status`, { completeness: 'complete', reason: 'starting' })).status).toBe(409);
    expect((await ownerA.client.req('PATCH', `/historical/periods/${id}/status`, { completeness: 'complete' })).status).toBe(400);
    expect((await ownerA.client.req('PATCH', `/historical/periods/${id}/status`, { reason: 'nothing' })).status).toBe(400);
    expect(await auditActions(id)).toEqual(['historical.period.create', 'historical.period.status_change']);
    const list = await ownerA.client.req('GET', '/historical/periods');
    expect(list.json.periods.find((x: { id: string }) => x.id === id).version_count).toBe(0);
  });

  it('supports draft operations and then freezes a sealed version', async () => {
    const p = await period();
    const d = await official(p, { submission_reference: 'REF-9' });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    const v = d.json.version.id;
    expect(d.json.version).toMatchObject({ state: 'draft', version_no: 1, provenance: 'official_declared_unverified', review_scope: 'internal_only', government_acceptance: 'not_implied' });
    // sealing needs lines
    const empty = await seal(v);
    expect(empty.status).toBe(409);
    expect(empty.json.code).toBe('HISTORICAL_VERSION_EMPTY');
    const l1 = await line(v, 'REV', '1000.50');
    const l2 = await line(v, 'EXP', '400');
    expect([l1.status, l2.status]).toEqual([201, 201]);
    expect((await line(v, 'REV', '5')).status).toBe(409);
    expect((await line(v, 'BAD', '1.234')).status).toBe(400);
    expect((await line(v, 'BAD', '1e3')).status).toBe(400);
    expect((await ownerA.client.req('POST', `/historical/versions/${v}/lines`, { line_code: 'NOLABEL', amount: '1' })).status).toBe(400);
    const upd = await ownerA.client.req('PATCH', `/historical/versions/${v}/lines/${l2.json.line.id}`, { amount: '450.00', note: 'rechecked' });
    expect(upd.json.line).toMatchObject({ amount: '450.00', note: 'rechecked' });
    const extra = await line(v, 'TMP', '1');
    expect((await ownerA.client.req('DELETE', `/historical/versions/${v}/lines/${extra.json.line.id}`)).status).toBe(200);
    // header edit and proof attachment
    const proof = await doc(A, ownerA);
    expect((await ownerA.client.req('PATCH', `/historical/versions/${v}`, { proof_level: 'proof_attached' })).status).toBe(422);
    const attached = await ownerA.client.req('PATCH', `/historical/versions/${v}`, { proof_level: 'proof_attached', proof_document_id: proof, submitted_to: 'ZATCA' });
    expect(attached.json.version).toMatchObject({ provenance: 'official_submitted_with_proof', submitted_to: 'ZATCA' });
    expect((await ownerA.client.req('PATCH', `/historical/versions/${v}`, { state: 'sealed' })).status).toBe(400);
    expect((await ownerA.client.req('PATCH', `/historical/versions/${v}`, { confidence: 'high' })).status).toBe(400);
    expect((await ownerA.client.req('POST', `/historical/versions/${v}/seal`, {})).status).toBe(400); // confirmation
    const sealed = await seal(v);
    expect(sealed.status, JSON.stringify(sealed.json)).toBe(200);
    expect(sealed.json.version.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const fp = sealed.json.version.fingerprint;
    // sealed: every content change is refused through the API...
    for (const r of [await line(v, 'LATE', '1'), await ownerA.client.req('PATCH', `/historical/versions/${v}/lines/${l1.json.line.id}`, { amount: '1' }),
      await ownerA.client.req('DELETE', `/historical/versions/${v}/lines/${l1.json.line.id}`), await ownerA.client.req('PATCH', `/historical/versions/${v}`, { submitted_to: 'X' }),
      await seal(v), await ownerA.client.req('POST', `/historical/versions/${v}/void`, { reason: 'no', confirm: true })]) {
      expect(r.status).toBe(409);
    }
    // ...and by the database itself
    await expect(h.q('UPDATE historical_statement_lines SET amount = 1 WHERE version_id = $1', [v])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    await expect(h.q("UPDATE historical_statement_versions SET submitted_to = 'X' WHERE id = $1", [v])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    const read = await ownerA.client.req('GET', `/historical/versions/${v}`);
    expect(read.json.version.fingerprint).toBe(fp);
    expect(read.json.lines.map((x: { line_code: string; amount: string }) => [x.line_code, x.amount])).toEqual([['REV', '1000.50'], ['EXP', '450.00']]);
    expect(await auditActions(v)).toEqual(['historical.version.create', 'historical.version.line_add', 'historical.version.line_add', 'historical.version.line_update',
      'historical.version.line_add', 'historical.version.line_remove', 'historical.version.update', 'historical.version.seal']);
  });

  it('voids drafts with a reason only', async () => {
    const p = await period();
    const v = (await official(p)).json.version.id;
    expect((await ownerA.client.req('POST', `/historical/versions/${v}/void`, { confirm: true })).status).toBe(400);
    const r = await ownerA.client.req('POST', `/historical/versions/${v}/void`, { confirm: true, reason: 'entered by mistake' });
    expect(r.status).toBe(200);
    expect(r.json.version).toMatchObject({ state: 'voided', void_reason: 'entered by mistake' });
    expect((await line(v, 'X', '1')).status).toBe(409);
    expect((await seal(v)).status).toBe(409);
    expect((await official(p)).json.version.version_no).toBe(2);
    expect(await auditActions(v)).toEqual(['historical.version.create', 'historical.version.void']);
  });

  it('records corrections and later official filings as new versions without touching the original', async () => {
    const p = await period();
    const v1 = await sealedOfficial(p);
    const before = (await ownerA.client.req('GET', `/historical/versions/${v1}`)).json;
    const bad = await ownerA.client.req('POST', `/historical/versions/${v1}/corrections`, { confirm: true, source_type: 'bank_statement' });
    expect(bad.status).toBe(400);
    const c = await ownerA.client.req('POST', `/historical/versions/${v1}/corrections`, { confirm: true, source_type: 'bank_statement', confidence: 'medium', evidence_reference: 'Bank Q1', method_note: 'revenue understated' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const v2 = c.json.version;
    expect(v2).toMatchObject({ kind: 'internal', internal_purpose: 'correction', basis_version_id: v1, version_no: 2, state: 'draft', provenance: 'internal_correction' });
    const copied = (await ownerA.client.req('GET', `/historical/versions/${v2.id}`)).json.lines;
    expect(copied).toHaveLength(2);
    const rev = copied.find((x: { line_code: string }) => x.line_code === 'REV');
    expect((await ownerA.client.req('PATCH', `/historical/versions/${v2.id}/lines/${rev.id}`, { amount: '1200.00' })).status).toBe(200);
    expect((await line(v2.id, 'OTH', '75.25')).status).toBe(201);
    expect((await ownerA.client.req('PATCH', `/historical/versions/${v2.id}`, { basis_version_id: null })).status).toBe(400);
    expect((await seal(v2.id)).status).toBe(200);
    // a correction needs a sealed basis
    const draft = (await official(p, { statement_type: 'cash_flow' })).json.version.id;
    expect((await ownerA.client.req('POST', `/historical/versions/${draft}/corrections`, { confirm: true, source_type: 'bank_statement', confidence: 'low' })).status).toBe(409);
    // a later official filing is another official version, not a replacement
    const later = (await official(p, { submission_date: '2021-02-01', submission_reference: 'AMENDED' })).json.version;
    expect(later).toMatchObject({ kind: 'official', version_no: 3, basis_version_id: null });
    await line(later.id, 'REV', '1200.00');
    expect((await seal(later.id)).status).toBe(200);
    // the original is untouched
    const after = (await ownerA.client.req('GET', `/historical/versions/${v1}`)).json;
    expect(after).toEqual(before);
    const hist = (await ownerA.client.req('GET', `/historical/versions/${v1}/history`)).json;
    expect(hist.versions.map((x: { version_no: number; provenance: string }) => [x.version_no, x.provenance])).toEqual([
      [1, 'official_declared_unverified'], [2, 'internal_correction'], [3, 'official_declared_unverified']]);
    expect(await auditActions(v2.id)).toContain('historical.version.correction_create');
  });

  it('reviews and approves internally, forward only, without implying government acceptance', async () => {
    const p = await period();
    const v = await sealedOfficial(p);
    const rev = (action: string, client = approver.client, vid = v) => client.req('POST', `/historical/versions/${vid}/review`, { action, confirm: true });
    expect((await rev('approve')).status).toBe(409);
    const r1 = await rev('review');
    expect(r1.json.version).toMatchObject({ review_status: 'reviewed', reviewed_by: approver.id, review_scope: 'internal_only', government_acceptance: 'not_implied' });
    expect((await rev('review')).status).toBe(409);
    const r2 = await rev('approve', ownerA.client);
    expect(r2.json.version).toMatchObject({ review_status: 'approved', approved_by: ownerA.id, provenance: 'official_declared_unverified' });
    expect((await rev('review')).status).toBe(409);
    expect((await ownerA.client.req('POST', `/historical/versions/${v}/review`, { action: 'approve' })).status).toBe(400);
    const draft = (await official(p, { statement_type: 'cash_flow' })).json.version.id;
    expect((await rev('review', approver.client, draft)).status).toBe(409);
    await expect(h.q("UPDATE historical_statement_versions SET review_status='reviewed' WHERE id=$1", [v])).rejects.toThrow(/HISTORICAL_RECORD_IMMUTABLE/);
    const audit = await h.q<{ action: string; after_data: Record<string, unknown> }>("SELECT action, after_data FROM audit_log WHERE entity_id=$1 AND action LIKE '%review' OR entity_id=$1 AND action LIKE '%approve'", [v]);
    expect(audit.map((x) => x.action).sort()).toEqual(['historical.version.approve', 'historical.version.review']);
    expect(audit[0]!.after_data['government_acceptance']).toBe('not_implied');
  });

  it('blocks internal work on a completed reconstruction until an approver reopens it with a reason', async () => {
    const p = await period();
    const base = { kind: 'internal', statement_type: 'financial_position', functional_currency: 'SAR', internal_purpose: 'reconstruction', source_type: 'bank_statement', confidence: 'medium' };
    expect((await ownerA.client.req('PATCH', `/historical/periods/${p}/status`, { reconstruction_status: 'in_progress', reason: 'start' })).status).toBe(200);
    const draft = await ownerA.client.req('POST', `/historical/periods/${p}/versions`, base);
    expect(draft.status, JSON.stringify(draft.json)).toBe(201);
    expect(draft.json.version.provenance).toBe('internal_reconstruction');
    await line(draft.json.version.id, 'CASH', '10.00');
    expect((await ownerA.client.req('PATCH', `/historical/periods/${p}/status`, { reconstruction_status: 'completed', reason: 'done' })).status).toBe(200);
    expect((await ownerA.client.req('POST', `/historical/periods/${p}/versions`, base)).json.code).toBe('HISTORICAL_RECONSTRUCTION_COMPLETED');
    expect((await seal(draft.json.version.id)).json.code).toBe('HISTORICAL_RECONSTRUCTION_COMPLETED');
    // official recording is not reconstruction work
    expect((await official(p)).status).toBe(201);
    expect((await manager.client.req('POST', `/historical/periods/${p}/reopen-reconstruction`, { reason: 'more', confirm: true })).status).toBe(403);
    expect((await approver.client.req('POST', `/historical/periods/${p}/reopen-reconstruction`, { confirm: true })).status).toBe(400);
    expect((await approver.client.req('POST', `/historical/periods/${p}/reopen-reconstruction`, { reason: 'missing statements found' })).status).toBe(400);
    const reopened = await approver.client.req('POST', `/historical/periods/${p}/reopen-reconstruction`, { reason: 'missing statements found', confirm: true });
    expect(reopened.status, JSON.stringify(reopened.json)).toBe(200);
    expect(reopened.json.period).toMatchObject({ reconstruction_status: 'in_progress', status_reason: 'missing statements found', status_changed_by: approver.id });
    expect((await approver.client.req('POST', `/historical/periods/${p}/reopen-reconstruction`, { reason: 'again', confirm: true })).status).toBe(409);
    expect((await seal(draft.json.version.id)).status).toBe(200);
    expect(await auditActions(p)).toEqual(['historical.period.create', 'historical.period.status_change', 'historical.period.status_change', 'historical.period.reconstruction_reopen']);
  });

  it('compares a version with its basis exactly and read-only', async () => {
    const p = await period();
    const v1 = await sealedOfficial(p, [['REV', '1000.10'], ['EXP', '400.00'], ['GONE', '50.00'], ['SAME', '7.00']]);
    const c = await ownerA.client.req('POST', `/historical/versions/${v1}/corrections`, { confirm: true, source_type: 'internal_ledger', confidence: 'high', evidence_reference: 'GL export' });
    const v2 = c.json.version.id;
    const lines = (await ownerA.client.req('GET', `/historical/versions/${v2}`)).json.lines as Array<{ id: string; line_code: string }>;
    const id = (code: string) => lines.find((x) => x.line_code === code)!.id;
    await ownerA.client.req('PATCH', `/historical/versions/${v2}/lines/${id('REV')}`, { amount: '1200.35' });
    await ownerA.client.req('DELETE', `/historical/versions/${v2}/lines/${id('GONE')}`);
    await line(v2, 'NEW', '12.50');
    const before = await h.q('SELECT line_code, amount::text FROM historical_statement_lines WHERE version_id = ANY($1) ORDER BY version_id, line_no', [[v1, v2]]);
    const r = await ownerA.client.req('GET', `/historical/versions/${v2}/comparison`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const by = Object.fromEntries(r.json.lines.map((x: { line_code: string }) => [x.line_code, x]));
    expect(by.REV).toMatchObject({ status: 'changed', basis_amount: '1000.10', version_amount: '1200.35', difference: '200.25' });
    expect(by.EXP).toMatchObject({ status: 'match', difference: '0.00' });
    expect(by.SAME).toMatchObject({ status: 'match' });
    expect(by.GONE).toMatchObject({ status: 'only_in_basis', basis_amount: '50.00', version_amount: null, difference: '-50.00' });
    expect(by.NEW).toMatchObject({ status: 'only_in_version', basis_amount: null, version_amount: '12.50', difference: '12.50' });
    expect(r.json.summary).toEqual({ matching: 2, changed: 1, only_in_basis: 1, only_in_version: 1, net_difference: '162.75' });
    expect(r.json.version).toMatchObject({ provenance: 'internal_correction', source_type: 'internal_ledger', confidence: 'high', evidence_reference: 'GL export' });
    expect(r.json.basis).toMatchObject({ id: v1, provenance: 'official_declared_unverified', proof_level: 'declared_unverified' });
    expect(r.json).toMatchObject({ read_only: true, accounting_effect: 'none' });
    expect(await h.q('SELECT line_code, amount::text FROM historical_statement_lines WHERE version_id = ANY($1) ORDER BY version_id, line_no', [[v1, v2]])).toEqual(before);
    // no declared basis: explicit `against` only, and only within the same period and statement
    expect((await ownerA.client.req('GET', `/historical/versions/${v1}/comparison`)).json.code).toBe('HISTORICAL_NO_BASIS');
    expect((await ownerA.client.req('GET', `/historical/versions/${v1}/comparison?against=${v2}`)).json.summary.net_difference).toBe('-162.75');
    const other = await sealedOfficial(await period());
    expect((await ownerA.client.req('GET', `/historical/versions/${v2}/comparison?against=${other}`)).json.code).toBe('HISTORICAL_COMPARISON_INVALID');
    expect((await ownerA.client.req('GET', `/historical/versions/${v2}/comparison?against=nope`)).status).toBe(400);
  });

  it('leaves journals, opening balances, fiscal years and closed periods untouched and logs no audit row for refused actions', async () => {
    const snapshot = async () => ({
      journals: await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1', [A]),
      lines: await h.count('SELECT COUNT(*)::text n FROM journal_lines WHERE company_id=$1', [A]),
      opening: await h.count('SELECT COUNT(*)::text n FROM opening_balance_reviews WHERE company_id=$1', [A]),
      monthly: await h.q("SELECT status, COUNT(*)::int n FROM monthly_close_periods WHERE company_id=$1 GROUP BY status ORDER BY status", [A]),
      years: await h.q('SELECT id, status, start_date::text s, end_date::text e FROM fiscal_years WHERE company_id=$1 ORDER BY id', [A]),
    });
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [fyA]);
    const acc = await h.account(A, 'H-1', 'asset', 'current_asset');
    const acc2 = await h.account(A, 'H-2', 'equity', 'equity');
    await h.postedJournal(A, fyA, '2024-02-01', ownerA.id, [[acc, '10.00', '0'], [acc2, '0', '10.00']]);
    const snap = await snapshot();
    expect(snap.journals).toBe(1);
    const p = await period();
    const v1 = await sealedOfficial(p);
    const corr = (await ownerA.client.req('POST', `/historical/versions/${v1}/corrections`, { confirm: true, source_type: 'bank_statement', confidence: 'low' })).json.version.id;
    await seal(corr);
    await approver.client.req('POST', `/historical/versions/${corr}/review`, { action: 'review', confirm: true });
    await ownerA.client.req('GET', `/historical/versions/${corr}/comparison`);
    expect(await snapshot()).toEqual(snap);
    // a refused mutation leaves neither data nor audit behind
    const auditBefore = await h.count('SELECT COUNT(*)::int::text n FROM audit_log WHERE company_id=$1', [A]);
    expect((await line(v1, 'LATE', '1')).status).toBe(409);
    expect((await manager.client.req('POST', `/historical/versions/${v1}/review`, { action: 'review', confirm: true })).status).toBe(403);
    expect(await h.count('SELECT COUNT(*)::int::text n FROM audit_log WHERE company_id=$1', [A])).toBe(auditBefore);
    // every audit row names the actor and company from the session
    const rows = await h.q<{ company_id: string; actor_user_id: string }>("SELECT company_id, actor_user_id FROM audit_log WHERE entity_id=$1 AND action LIKE 'historical.%'", [corr]);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.company_id))).toEqual(new Set([A]));
  });
});
