import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { acceptAllIncomplete } from './helpers/ob-exceptions';
import { ACCOUNTANT_CAPABILITIES, FINANCE_MANAGER_DEFAULT_CAPABILITIES } from '../src/modules/memberships/default-role-capabilities';

// C4-P2b-1: opening balance evidence exceptions over real HTTP + PostgreSQL. Requires a disposable DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;
const BLOCKED = 'OPENING_BALANCE_RECONCILIATION_BLOCKED';

describeDatabase('opening balance evidence exceptions (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  async function setup(label: string) {
    const owner = await h.user(`${label}-own`);
    const accountant = await h.user(`${label}-acc`);
    const manager = await h.user(`${label}-fm`);
    const viewer = await h.user(`${label}-view`);
    const noCap = await h.user(`${label}-none`);
    const id = await h.company(label, owner.id);
    await h.member(id, accountant.id, [...ACCOUNTANT_CAPABILITIES]);
    await h.member(id, manager.id, [...FINANCE_MANAGER_DEFAULT_CAPABILITIES]);
    await h.member(id, viewer.id, ['opening_balance.view']);
    await h.member(id, noCap.id, ['obligation.view']);
    for (const u of [owner, accountant, manager, viewer, noCap]) await u.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    await h.q(
      `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,prepared_by_user_id,approved_by_user_id,approved_at)
       VALUES($1,1,'approved','IFRS','SAR','SAR','2025-01-01','not_registered','zakat_applicable','saudi_gcc_only','not_currently_applicable','no','2025-01-01',$2,$2,NOW())`, [id, owner.id]);
    const bankGl = await h.account(id, 'OB-BANK', 'asset', 'current_asset');
    const bankGl2 = await h.account(id, 'OB-BANK2', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=ANY($1::uuid[])", [[bankGl, bankGl2]]);
    const ar = await h.account(id, 'OB-AR', 'asset', 'current_asset');
    const arChild = await h.account(id, 'OB-AR-1', 'asset', 'current_asset');
    await h.q('UPDATE accounts SET parent_account_id=$2 WHERE id=$1', [arChild, ar]);
    const ap = await h.account(id, 'OB-AP', 'liability', 'current_liability');
    const equity = await h.account(id, 'OB-EQ', 'equity', 'equity');
    const other = await h.account(id, 'OB-OTHER', 'asset', 'current_asset');
    for (const [key, acc] of [['receivable', ar], ['payable', ap]] as const) {
      await h.q('INSERT INTO invoice_account_mappings(company_id,mapping_key,account_id,updated_by_user_id) VALUES($1,$2,$3,$4)', [id, key, acc, owner.id]);
    }
    const mkBank = async (name: string, currency = 'SAR') =>
      (await h.q<{ id: string }>('INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,$2,$3,$4) RETURNING id', [id, name, currency, owner.id]))[0]!.id;
    const bank = await mkBank('Main');
    const cp = (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Customer A','customer',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const cp2 = (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Supplier B','supplier',$2) RETURNING id", [id, owner.id]))[0]!.id;
    return { id, fy, owner, accountant, manager, viewer, noCap, bankGl, bankGl2, ar, arChild, ap, equity, other, bank, cp, cp2, mkBank };
  }
  type Co = Awaited<ReturnType<typeof setup>>;

  const link = (co: Co, bank = co.bank, account = co.bankGl, from = '2025-01-01') =>
    h.q('INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,$4,$5)', [co.id, bank, account, from, co.owner.id]);
  const statement = (co: Co, closing: string, bank = co.bank, end = '2025-12-31', status = 'confirmed') =>
    h.q(`INSERT INTO bank_statement_balances(company_id,bank_account_id,currency_code,statement_ref,period_start,period_end,closing_balance,status,confirmed_by,confirmed_at,created_by)
         VALUES($1,$2,'SAR',$3,'2025-12-01',$4,$5,$6,$7,CASE WHEN $6='confirmed' THEN NOW() END,$8)`, [co.id, bank, `S-${randomUUID().slice(0, 6)}`, end, closing, status, status === 'confirmed' ? co.owner.id : null, co.owner.id]);
  const obligation = async (co: Co, direction: 'receivable' | 'payable', amount: string, counterparty = direction === 'receivable' ? co.cp : co.cp2, o: { source_type?: string; recognized_on?: string } = {}) =>
    (await h.q<{ id: string }>(
      `INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,$2,$3,$4,$5,'confirmed',$6,$7) RETURNING id`,
      [co.id, direction, counterparty, amount, o.recognized_on ?? '2026-01-01', o.source_type ?? 'opening_balance', co.owner.id]))[0]!.id;
  const addItem = async (co: Co, body: Record<string, unknown>) => {
    const r = await co.accountant.client.req('POST', `/opening-balances/${co.fy}/items`, { source_type: 'original_document', confidence: 'high', ...body });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.item as { id: string; version: number };
  };
  const bankItem = (co: Co, amount: string, o: Record<string, unknown> = {}) => addItem(co, { category: 'bank', account_id: co.bankGl, amount, balance_side: 'debit', bank_account_id: co.bank, ...o });
  const arItem = (co: Co, amount: string, obligation_id: string | null, o: Record<string, unknown> = {}) =>
    addItem(co, { category: 'receivable', account_id: co.ar, amount, balance_side: 'debit', ...(obligation_id ? { obligation_id, counterparty_id: co.cp } : {}), ...o });
  const balance = (co: Co, amount: string) => addItem(co, { category: 'equity', account_id: co.equity, amount, balance_side: 'credit' });
  /** The real trial-balance import path (the only source of genuine aggregate rows). */
  const importTb = async (co: Co, rows: Array<{ account: string; category: string; debit?: string; credit?: string }>) => {
    const r = await co.accountant.client.req('POST', `/opening-balances/${co.fy}/import`, {
      confirm: true, file_name: 'tb.csv',
      items: rows.map((x, i) => ({ row: i + 1, account_id: x.account, debit: x.debit ?? '0.00', credit: x.credit ?? '0.00', category: x.category })),
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.items as Array<{ id: string; version: number }>;
  };
  const patch = (co: Co, it: { id: string; version: number }, body: Record<string, unknown>) =>
    co.accountant.client.req('PATCH', `/opening-balances/${co.fy}/items/${it.id}`, { version: it.version, ...body });
  const submit = (co: Co) => co.manager.client.req('POST', `/opening-balances/${co.fy}/submit-review`, {});
  const accept = async (co: Co) => { const r = await acceptAllIncomplete(co.manager.client, co.fy); expect([200, 201]).toContain(r.status); };
  const approve = (co: Co) => co.manager.client.req('POST', `/opening-balances/${co.fy}/approve`, {});
  const report = (co: Co) => co.viewer.client.req('GET', `/opening-balances/${co.fy}/reconciliation`);
  const reviewStatus = async (co: Co) => (await h.q<{ status: string }>('SELECT status FROM opening_balance_reviews WHERE company_id=$1', [co.id]))[0]?.status;
  const journals = (co: Co) => h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1', [co.id]);
  const issueCodes = (r: { json: any }) => (r.json.issues as Array<{ code: string }>).map((i) => i.code);
  const REASON = 'Supplier statement requested, accepted pending receipt';
  const prepared = async (label: string, withObligation = false) => {
    const co = await setup(label);
    await importTb(co, [
      { account: co.bankGl, category: 'bank', debit: '700.00' }, { account: co.ar, category: 'receivable', debit: '300.00' }, { account: co.equity, category: 'equity', credit: '1000.00' },
    ]);
    if (withObligation) await obligation(co, 'receivable', '50.00');
    expect((await submit(co)).status).toBe(200);
    return co;
  };
  const list = (co: Co, who = co.manager) => who.client.req('GET', `/opening-balances/${co.fy}/exceptions`);
  const post = (co: Co, body: unknown, who = co.manager) => who.client.req('POST', `/opening-balances/${co.fy}/exceptions`, body);
  const revoke = (co: Co, id: string, reason: unknown, who = co.manager) => who.client.req('POST', `/opening-balances/${co.fy}/exceptions/${id}/revoke`, { reason });
  const entry = (i: any, extra: Record<string, unknown> = {}) => ({
    issue_key: i.issue_key, evidence_fingerprint: i.evidence_fingerprint, reason: REASON,
    ...(i.code === 'OB_SUBLEDGER_TOTAL_DIFFERENCE' ? { acknowledged_difference: i.detail.difference } : {}), ...extra,
  });
  const issueOf = (r: { json: any }, code: string) => (r.json.issues as any[]).find((i) => i.code === code);
  const rows = (co: Co, where = '') => h.q<any>(`SELECT * FROM opening_balance_evidence_exceptions WHERE company_id=$1 ${where} ORDER BY accepted_at,id`, [co.id]);
  const reviewId = async (co: Co) => (await h.q<{ id: string }>('SELECT id FROM opening_balance_reviews WHERE company_id=$1', [co.id]))[0]!.id;
  const audits = (co: Co, action: string) => h.count('SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action=$2', [co.id, action]);
  const dbError = async (sql: string, params: unknown[] = []) => { try { await h.db.query(sql, params); return null; } catch (e) { return e as { code?: string; message: string }; } };
  const rawInsert = async (co: Co, o: { review?: string; company?: string; item?: string | null; code: string; section?: string; reason?: string; status?: string }) =>
    dbError(`INSERT INTO opening_balance_evidence_exceptions(company_id,review_id,item_id,section,issue_code,issue_key,issue_snapshot,evidence_fingerprint,reason,accepted_by,status,ended_at,end_reason)
             VALUES($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$8,$9,$10,CASE WHEN $10='active' THEN NULL ELSE NOW() END,CASE WHEN $10='active' THEN NULL ELSE 'x' END)`,
      [o.company ?? co.id, o.review ?? await reviewId(co), o.item ?? null, o.section ?? 'bank', o.code, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), 'a'.repeat(64), o.reason ?? REASON, co.owner.id, o.status ?? 'active']);
  const evaluateAll = async (co: Co) => {
    const { evaluateOpeningEvidence } = await import('../src/modules/opening-balances/opening-balance-exceptions');
    const c = await h.db.connect();
    try { return await evaluateOpeningEvidence(c, co.id, await reviewId(co), '2026-01-01'); } finally { c.release(); }
  };
  const snapshot = async (co: Co) => ({
    journals: await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1', [co.id]),
    lines: await h.count('SELECT COUNT(*)::text n FROM journal_lines WHERE company_id=$1', [co.id]),
    obligations: await h.q('SELECT id,original_amount::text,is_cancelled FROM obligations WHERE company_id=$1 ORDER BY id', [co.id]),
    statements: await h.count('SELECT COUNT(*)::text n FROM bank_statement_balances WHERE company_id=$1', [co.id]),
    items: await h.q('SELECT id,amount::text,balance_side,source_type,confidence,note,version FROM opening_balance_items WHERE company_id=$1 ORDER BY id', [co.id]),
    review: await h.q('SELECT status,version,journal_entry_id FROM opening_balance_reviews WHERE company_id=$1', [co.id]),
  });

  it('C4-UI1: returns the accepting user display name (read-only, company-scoped) and a null fallback; accepted_by stays the UUID', async () => {
    const co = await prepared('nm');
    const bank = issueOf(await list(co), 'OB_BANK_AGGREGATE_ONLY');
    expect((await post(co, [entry(bank)])).status).toBe(201);
    // No display name set: null, never the email or the UUID.
    let ex = (await list(co)).json.exceptions[0];
    expect(ex.accepted_by).toBe(co.manager.id);
    expect(ex.accepted_by_name).toBeNull();
    await h.q("UPDATE users SET display_name='Nora Al-Shehri' WHERE id=$1", [co.manager.id]);
    ex = (await list(co)).json.exceptions[0];
    expect(ex).toMatchObject({ accepted_by: co.manager.id, accepted_by_name: 'Nora Al-Shehri', ended_by_name: null });
    expect(JSON.stringify(ex)).not.toContain('@');
    // A user who no longer belongs to this company is not resolved (no cross-tenant directory exposure).
    await h.q('DELETE FROM memberships WHERE user_id=$1 AND company_id=$2', [co.manager.id, co.id]);
    ex = (await list(co, co.owner)).json.exceptions[0];
    expect(ex.accepted_by_name).toBeNull();
  });

  it('accepts an incomplete-evidence issue with identity, fingerprint and reason, never changes the classification, and revokes with a reason', async () => {
    const co = await prepared('acc');
    const l = await list(co);
    expect(l.status).toBe(200);
    expect(l.json).toMatchObject({ review_status: 'in_review', required_count: 3, accepted_unverified_count: 0, stale_count: 0, disclosure: 'Accepted — not verified.', exceptions: [] });
    const bank = issueOf(l, 'OB_BANK_AGGREGATE_ONLY');
    expect(bank).toMatchObject({ class: 'incomplete_evidence', section: 'bank', acceptable: true, acceptance: 'none' });
    expect(bank.issue_key).toMatch(/^[0-9a-f]{64}$/);
    expect(bank.evidence_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const before = (await report(co)).json;

    const r = await post(co, [entry(bank)]);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.disclosure).toBe('Accepted — not verified.');
    const ex = r.json.exceptions[0];
    expect(ex).toMatchObject({ status: 'active', issue_code: 'OB_BANK_AGGREGATE_ONLY', section: 'bank', item_id: bank.item_id, issue_key: bank.issue_key, evidence_fingerprint: bank.evidence_fingerprint, accepted_by: co.manager.id, reason: REASON });
    expect(ex.accepted_at).toBeTruthy();
    expect((await rows(co))[0].issue_snapshot).toMatchObject({ code: 'OB_BANK_AGGREGATE_ONLY', class: 'incomplete_evidence', section: 'bank', item_id: bank.item_id });
    // The original classification is untouched: acceptance is not verification.
    expect((await report(co)).json).toEqual(before);
    expect(before.status).toBe('incomplete_evidence');
    const l2 = await list(co);
    expect(l2.json.accepted_unverified_count).toBe(1);
    expect(issueOf(l2, 'OB_BANK_AGGREGATE_ONLY')).toMatchObject({ acceptance: 'accepted_unverified', exception_id: ex.id });
    expect(await audits(co, 'opening_balance.exception.accept')).toBe(1);
    expect((await h.q<any>("SELECT reason,actor_user_id FROM audit_log WHERE company_id=$1 AND action='opening_balance.exception.accept'", [co.id]))[0]).toMatchObject({ reason: REASON, actor_user_id: co.manager.id });

    // Revocation needs a meaningful reason, keeps the row, and makes the issue need acceptance again.
    for (const bad of [undefined, '', '   ', 'too short']) expect([(await revoke(co, ex.id, bad)).status, (await revoke(co, ex.id, bad)).json.code]).toEqual([400, 'OB_EXCEPTION_REASON_REQUIRED']);
    const rv = await revoke(co, ex.id, 'Statement arrived and disagrees');
    expect(rv.status, JSON.stringify(rv.json)).toBe(200);
    expect(rv.json.exception).toMatchObject({ status: 'revoked', ended_by: co.manager.id, end_reason: 'Statement arrived and disagrees' });
    expect((await rows(co)).map((x) => x.status)).toEqual(['revoked']);
    expect(await audits(co, 'opening_balance.exception.revoke')).toBe(1);
    expect(issueOf(await list(co), 'OB_BANK_AGGREGATE_ONLY').acceptance).toBe('none');
    const again = await revoke(co, ex.id, 'Revoking a second time');
    expect([again.status, again.json.code]).toEqual([409, 'OB_EXCEPTION_NOT_ACTIVE']);
    expect((await revoke(co, randomUUID(), REASON)).status).toBe(404);

    const re = await post(co, [entry(issueOf(await list(co), 'OB_BANK_AGGREGATE_ONLY'))]);
    expect(re.status).toBe(201);
    expect((await rows(co)).map((x) => x.status)).toEqual(['revoked', 'active']);
  });

  it('enforces capabilities and company isolation', async () => {
    const A = await prepared('pA'), B = await prepared('pB');
    const l = await list(A);
    const bank = issueOf(l, 'OB_BANK_AGGREGATE_ONLY'), ar = issueOf(l, 'OB_SUBLEDGER_AGGREGATE_ONLY');
    expect((await post(A, [entry(bank)], A.accountant)).status).toBe(403);
    expect((await post(A, [entry(bank)], A.viewer)).status).toBe(403);
    expect((await post(A, [entry(bank)], A.noCap)).status).toBe(403);
    expect((await list(A, A.noCap)).status).toBe(403);
    expect((await list(A, A.viewer)).status).toBe(200); // view only
    expect((await list(A, A.accountant)).status).toBe(200);
    expect(await rows(A)).toHaveLength(0);

    const full = await post(A, [entry(bank)], A.owner); // Full Access holds every registered capability
    expect(full.status).toBe(201);
    const id = full.json.exceptions[0].id;
    expect((await revoke(A, id, REASON, A.accountant)).status).toBe(403);
    expect((await revoke(A, id, REASON, A.viewer)).status).toBe(403);
    // Another company's manager can neither see nor use A's review or exceptions.
    expect((await B.manager.client.req('GET', `/opening-balances/${A.fy}/exceptions`)).status).toBe(404);
    expect((await B.manager.client.req('POST', `/opening-balances/${A.fy}/exceptions`, [entry(ar)])).status).toBe(404);
    expect((await B.manager.client.req('POST', `/opening-balances/${A.fy}/exceptions/${id}/revoke`, { reason: REASON })).status).toBe(404);
    const cross = await revoke(B, id, REASON);
    expect([cross.status, cross.json.code]).toEqual([404, 'OB_EXCEPTION_NOT_FOUND']);
    // A key from A is not an issue of B.
    const foreign = await post(B, [entry(bank)]);
    expect([foreign.status, foreign.json.code]).toEqual([404, 'OB_EXCEPTION_ISSUE_NOT_FOUND']);
    expect(await rows(B)).toHaveLength(0);
    expect((await rows(A)).map((x) => x.status)).toEqual(['active']);
  });

  it('keeps accepted records immutable and non-deletable in the database, and refuses blocked/mismatch codes even on a direct INSERT', async () => {
    const co = await prepared('imm');
    const bank = issueOf(await list(co), 'OB_BANK_AGGREGATE_ONLY');
    const id = (await post(co, [entry(bank)])).json.exceptions[0].id;
    for (const [col, val] of [['reason', "'a rewritten reason here'"], ['evidence_fingerprint', `'${'b'.repeat(64)}'`], ['issue_key', `'${'c'.repeat(64)}'`], ['issue_snapshot', "'{}'::jsonb"], ['accepted_by', `'${co.owner.id}'`], ['accepted_at', "NOW() + INTERVAL '1 day'"], ['issue_code', "'OB_REFERENCE_MISSING'"]]) {
      expect((await dbError(`UPDATE opening_balance_evidence_exceptions SET ${col}=${val} WHERE id=$1`, [id]))?.code, col).toBe('55000');
    }
    expect((await dbError('DELETE FROM opening_balance_evidence_exceptions WHERE id=$1', [id]))?.code).toBe('55000');
    expect((await dbError('DELETE FROM opening_balance_evidence_exceptions WHERE company_id=$1', [co.id]))?.code).toBe('55000');
    expect((await dbError("UPDATE opening_balance_evidence_exceptions SET status='revoked',ended_at=NOW() WHERE id=$1", [id]))?.code, 'revoke needs ended_by and a reason').toBe('23514');
    expect((await revoke(co, id, REASON)).status).toBe(200);
    for (const sql of ["UPDATE opening_balance_evidence_exceptions SET status='active',ended_at=NULL,ended_by=NULL,end_reason=NULL WHERE id=$1", "UPDATE opening_balance_evidence_exceptions SET end_reason='another long reason' WHERE id=$1", "UPDATE opening_balance_evidence_exceptions SET status='superseded' WHERE id=$1"]) {
      expect((await dbError(sql, [id]))?.code, sql).toBe('55000');
    }
    expect((await rows(co)).map((x) => x.status)).toEqual(['revoked']);

    // Only the nine incomplete-evidence codes exist for the table: every blocked, mismatch or unknown code is refused.
    const { OB_CODES } = await import('../src/modules/opening-balances/opening-balance-reconciliation');
    const { OB_EXCEPTION_ELIGIBLE_CODES } = await import('../src/modules/opening-balances/opening-balance-exceptions');
    const item = (await h.q<{ id: string }>('SELECT id FROM opening_balance_items WHERE company_id=$1 LIMIT 1', [co.id]))[0]!.id;
    const refused = Object.values(OB_CODES).filter((c) => !OB_EXCEPTION_ELIGIBLE_CODES.includes(c));
    expect(refused.length).toBeGreaterThanOrEqual(13);
    for (const code of [...refused, 'OB_SOMETHING_NEW']) expect((await rawInsert(co, { code, item }))?.code, code).toBe('23514');
    for (const code of OB_EXCEPTION_ELIGIBLE_CODES) {
      const aggregate = ['OB_SUBLEDGER_UNLINKED_OBLIGATION', 'OB_SUBLEDGER_TOTAL_DIFFERENCE'].includes(code);
      if (aggregate) continue;
      expect((await rawInsert(co, { code, item, reason: '          ' }))?.code, `${code} blank reason`).toBe('23514');
      expect((await rawInsert(co, { code, item, reason: 'abc def gh' }))?.code, `${code} 8 characters`).toBe('23514');
    }
    expect((await rawInsert(co, { code: 'OB_BANK_AGGREGATE_ONLY', item: null }))?.code, 'item scope').toBe('23514');
    expect(['55000', '23503'], 'composite company FK / review scope').toContain((await rawInsert(co, { code: 'OB_BANK_AGGREGATE_ONLY', item, status: 'active', company: (await prepared('immB')).id }))?.code);
    expect((await rawInsert(co, { code: 'OB_BANK_AGGREGATE_ONLY', item: randomUUID() }))?.code, 'item must belong to the review').toBe('23503');
  });

  it('cannot insert while the review is draft or approved, and freezes every record once approved', async () => {
    const draft = await setup('immDraft');
    await bankItem(draft, '10.00', { bank_account_id: null });
    const item = (await h.q<{ id: string }>('SELECT id FROM opening_balance_items WHERE company_id=$1', [draft.id]))[0]!.id;
    expect((await rawInsert(draft, { code: 'OB_REFERENCE_MISSING', item }))?.code).toBe('55000');
    const dr = await post(draft, [{ issue_key: 'a'.repeat(64), evidence_fingerprint: 'b'.repeat(64), reason: REASON }]);
    expect([dr.status, dr.json.code]).toEqual([409, 'OB_EXCEPTION_REVIEW_STATE']);

    const co = await prepared('immAppr');
    expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
    expect((await approve(co)).status).toBe(200);
    const [row] = await rows(co);
    const item2 = row.item_id;
    expect((await rawInsert(co, { code: 'OB_REFERENCE_MISSING', item: item2 }))?.code).toBe('55000');
    expect((await dbError("UPDATE opening_balance_evidence_exceptions SET status='revoked',ended_by=$2,ended_at=NOW(),end_reason='long enough reason' WHERE id=$1", [row.id, co.owner.id]))?.code).toBe('55000');
    expect((await dbError('UPDATE opening_balance_evidence_exceptions SET reason=reason WHERE id=$1', [row.id]))?.code).toBe('55000');
    expect((await dbError('DELETE FROM opening_balance_evidence_exceptions WHERE id=$1', [row.id]))?.code).toBe('55000');
    const apiRevoke = await revoke(co, row.id, REASON);
    expect([apiRevoke.status, apiRevoke.json.code]).toEqual([409, 'OB_EXCEPTION_REVIEW_STATE']);
    const apiAccept = await post(co, [{ issue_key: row.issue_key, evidence_fingerprint: row.evidence_fingerprint, reason: REASON }]);
    expect([apiAccept.status, apiAccept.json.code]).toEqual([409, 'OB_EXCEPTION_REVIEW_STATE']);
    expect((await rows(co)).every((x) => x.status === 'active')).toBe(true);
  });

  it('requires a reason of at least 10 non-whitespace characters, validates the body, and is all-or-nothing', async () => {
    const co = await prepared('rsn');
    const l = await list(co);
    const bank = issueOf(l, 'OB_BANK_AGGREGATE_ONLY'), ar = issueOf(l, 'OB_SUBLEDGER_AGGREGATE_ONLY');
    for (const reason of ['', '   ', 'short', '   a b c d e   ', 'abcde fghi', '\n\t     x']) {
      const r = await post(co, [entry(bank, { reason })]);
      expect([r.status, r.json.code], JSON.stringify(reason)).toEqual([400, 'OB_EXCEPTION_REASON_REQUIRED']);
    }
    const r1 = await post(co, [entry(bank, { reason: 'x'.repeat(1001) })]);
    expect([r1.status, r1.json.code]).toEqual([400, 'OB_EXCEPTION_REASON_REQUIRED']);
    // Structural problems: not an array, empty, unknown keys, bad hex, duplicates, no reason.
    for (const body of [{}, [], [{ ...entry(bank), extra: 1 }], [{ ...entry(bank), issue_key: 'nothex' }], [entry(bank), entry(bank)], [{ issue_key: bank.issue_key, evidence_fingerprint: bank.evidence_fingerprint }], [entry(bank, { reason: 5 })]]) {
      const r = await post(co, body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([400, 'OB_EXCEPTION_INVALID']);
    }
    // One bad entry rejects the whole request.
    const mixed = await post(co, [entry(bank), entry(ar, { reason: 'too short' })]);
    expect(mixed.status).toBe(400);
    expect(await rows(co)).toHaveLength(0);
    // Exactly ten non-whitespace characters are enough; surrounding whitespace is trimmed.
    const ok = await post(co, [entry(bank, { reason: '  abcde fghij  ' })]);
    expect(ok.status).toBe(201);
    expect(ok.json.exceptions[0].reason).toBe('abcde fghij');
    const unknown = await post(co, [{ issue_key: 'e'.repeat(64), evidence_fingerprint: 'f'.repeat(64), reason: REASON }]);
    expect([unknown.status, unknown.json.code]).toEqual([404, 'OB_EXCEPTION_ISSUE_NOT_FOUND']);
    const dup = await post(co, [entry(bank)]);
    expect([dup.status, dup.json.code]).toEqual([409, 'OB_EXCEPTION_ALREADY_ACTIVE']);
    expect(dup.json.issue).toMatchObject({ code: 'OB_BANK_AGGREGATE_ONLY', section: 'bank', item_id: bank.item_id });
  });

  it('refuses approval without a valid acceptance for every incomplete issue, then approves and records the exceptions in the audit event', async () => {
    const co = await prepared('appr');
    const first = await approve(co);
    expect([first.status, first.json.code]).toEqual([409, 'OPENING_BALANCE_EXCEPTIONS_REQUIRED']);
    expect(first.json.missing.map((i: any) => i.code).sort()).toEqual(['OB_BANK_AGGREGATE_ONLY', 'OB_SUBLEDGER_AGGREGATE_ONLY', 'OB_SUBLEDGER_TOTAL_DIFFERENCE']);
    expect(first.json.missing[0]).toMatchObject({ class: 'incomplete_evidence' });
    expect(first.json.missing[0].issue_key).toMatch(/^[0-9a-f]{64}$/);
    expect(await reviewStatus(co)).toBe('in_review');
    expect(await journals(co)).toBe(0);

    const l = await list(co);
    expect((await post(co, [entry(issueOf(l, 'OB_BANK_AGGREGATE_ONLY'))])).status).toBe(201);
    const second = await approve(co);
    expect([second.status, second.json.code]).toEqual([409, 'OPENING_BALANCE_EXCEPTIONS_REQUIRED']);
    expect(second.json.missing.map((i: any) => i.code).sort()).toEqual(['OB_SUBLEDGER_AGGREGATE_ONLY', 'OB_SUBLEDGER_TOTAL_DIFFERENCE']);
    expect(await journals(co)).toBe(0);

    expect((await post(co, [entry(issueOf(await list(co), 'OB_SUBLEDGER_AGGREGATE_ONLY')), entry(issueOf(await list(co), 'OB_SUBLEDGER_TOTAL_DIFFERENCE'))])).status).toBe(201);
    const done = await approve(co);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(await reviewStatus(co)).toBe('approved');
    expect(await journals(co)).toBe(1);
    const ev = (await h.q<any>("SELECT after_data FROM audit_log WHERE company_id=$1 AND action='opening_balance.approve'", [co.id]))[0].after_data;
    expect(ev.status).toBe('approved');
    expect(ev.accepted_evidence_exceptions.map((e: any) => e.issue_code).sort()).toEqual(['OB_BANK_AGGREGATE_ONLY', 'OB_SUBLEDGER_AGGREGATE_ONLY', 'OB_SUBLEDGER_TOTAL_DIFFERENCE']);
    expect(ev.accepted_evidence_exceptions[0]).toMatchObject({ reason: REASON, accepted_by: co.manager.id, disclosure: 'Accepted — not verified.' });
    expect(ev.reconciliation).toMatchObject({ status: 'incomplete_evidence', blocking: false });
    expect(await audits(co, 'opening_balance.approve')).toBe(1);
  });

  it('never accepts blocked or mismatch findings, and they keep stopping approval even when every incomplete issue is accepted', async () => {
    const co = await setup('blk');
    await link(co); await statement(co, '1000.00');
    const o = await obligation(co, 'receivable', '100.00');
    await bankItem(co, '1000.00');
    await arItem(co, '90.00', o); // mismatch: 90.00 against the 100.00 obligation
    await addItem(co, { category: 'bank', account_id: co.bankGl2, amount: '5.00', balance_side: 'debit' }); // incomplete: no bank reference
    await balance(co, '1095.00');
    await h.q("UPDATE opening_balance_reviews SET status='in_review',submitted_by=$2,submitted_at=NOW() WHERE company_id=$1", [co.id, co.owner.id]); // bypasses the submit gate on purpose
    const ev = await evaluateAll(co);
    const hard = ev.issues.filter((i) => i.class !== 'incomplete_evidence');
    expect(hard.map((i) => i.code)).toContain('OB_OBLIGATION_AMOUNT_MISMATCH');
    for (const i of hard) {
      const r = await post(co, [{ issue_key: i.issue_key, evidence_fingerprint: i.evidence_fingerprint, reason: REASON }]);
      expect([r.status, r.json.code], i.code).toEqual([409, 'OB_EXCEPTION_NOT_ELIGIBLE']);
    }
    const l = await list(co);
    expect(l.json).toMatchObject({ blocking: true, reconciliation_status: 'mismatch' });
    expect((l.json.issues as any[]).every((i) => i.class === 'incomplete_evidence')).toBe(true);
    expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
    const r = await approve(co);
    expect([r.status, r.json.code, r.json.status]).toEqual([409, 'OPENING_BALANCE_RECONCILIATION_BLOCKED', 'mismatch']);
    expect(await journals(co)).toBe(0);
    expect(await rows(co)).toHaveLength(2); // the missing bank reference and the receivable total (90.00 against 100.00)
    expect((await report(co)).json.status).toBe('mismatch'); // acceptance did not reclassify anything
  });

  it('accepts an aggregate total difference only with the exact displayed difference acknowledged', async () => {
    const co = await prepared('diff', true);
    const l = await list(co);
    const total = issueOf(l, 'OB_SUBLEDGER_TOTAL_DIFFERENCE');
    expect(total).toMatchObject({ section: 'receivable', acceptable: true, detail: { gl_total: '300.00', subledger_total: '50.00', difference: '250.00' } });
    expect(total.item_id).toBeUndefined();
    for (const ack of [undefined, '100.00', '250', '-250.00', 250]) {
      const r = await post(co, [{ issue_key: total.issue_key, evidence_fingerprint: total.evidence_fingerprint, reason: REASON, ...(ack === undefined ? {} : { acknowledged_difference: ack }) }]);
      expect(r.status, String(ack)).toBe(400);
      if (ack === undefined || ack === '100.00' || ack === '-250.00') expect(r.json.code).toBe('OB_EXCEPTION_DIFFERENCE_ACK_REQUIRED');
    }
    const bank = issueOf(l, 'OB_BANK_AGGREGATE_ONLY');
    const stray = await post(co, [entry(bank, { acknowledged_difference: '1.00' })]);
    expect(stray.status).toBe(400);
    expect(await rows(co)).toHaveLength(0);
    const ok = await post(co, [entry(total)]);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.exceptions[0]).toMatchObject({ acknowledged_difference: '250.00', item_id: null, issue_code: 'OB_SUBLEDGER_TOTAL_DIFFERENCE' });
    const gap = await approve(co);
    expect(gap.json.code).toBe('OPENING_BALANCE_EXCEPTIONS_REQUIRED'); // the other three incomplete issues are still unaccepted
    expect(gap.json.missing.map((i: any) => i.code).sort()).toEqual(['OB_BANK_AGGREGATE_ONLY', 'OB_SUBLEDGER_AGGREGATE_ONLY', 'OB_SUBLEDGER_UNLINKED_OBLIGATION']);
    expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
    expect((await approve(co)).status).toBe(200);
  });

  describe('evidence changes invalidate stale acceptance', () => {
    const staleThenReaccept = async (co: Co, codes: string[]) => {
      const r = await approve(co);
      expect([r.status, r.json.code], JSON.stringify(r.json)).toEqual([409, 'OB_EXCEPTION_STALE']);
      expect(r.json.stale.map((i: any) => i.code).sort()).toEqual([...codes].sort());
      expect(await journals(co)).toBe(0);
      expect(await reviewStatus(co)).toBe('in_review');
      const l = await list(co);
      for (const code of codes) expect(issueOf(l, code).acceptance, code).toBe('stale');
      expect(l.json.stale_count).toBe(codes.length);
      // A client holding the old fingerprint is refused; the displayed one supersedes the stale record.
      const old = (await rows(co)).find((x) => x.issue_code === codes[0]);
      const refused = await post(co, [{ issue_key: old.issue_key, evidence_fingerprint: old.evidence_fingerprint, reason: REASON }]);
      expect([refused.status, refused.json.code]).toEqual([409, 'OB_EXCEPTION_STALE']);
      expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
      const all = await rows(co);
      expect(all.filter((x) => x.status === 'superseded').map((x) => x.end_reason)).toEqual(codes.map(() => 'evidence_changed'));
      expect(all.filter((x) => x.status === 'active').length).toBeGreaterThanOrEqual(codes.length);
      expect(await audits(co, 'opening_balance.exception.supersede')).toBe(codes.length);
      expect((await approve(co)).status).toBe(200);
    };

    it('an opening obligation amount', async () => {
      const co = await prepared('stObl', true);
      expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
      await h.q("UPDATE obligations SET original_amount=60.00 WHERE company_id=$1 AND source_type='opening_balance'", [co.id]);
      await staleThenReaccept(co, ['OB_SUBLEDGER_TOTAL_DIFFERENCE', 'OB_SUBLEDGER_UNLINKED_OBLIGATION']);
    });

    it('bank statement evidence', async () => {
      const co = await setup('stBank');
      await link(co);
      await bankItem(co, '500.00', { bank_account_id: null });
      await balance(co, '500.00');
      expect((await submit(co)).status).toBe(200);
      const l = await list(co);
      expect(l.json.issues.map((i: any) => i.code).sort()).toEqual(['OB_BANK_EVIDENCE_MISSING', 'OB_REFERENCE_MISSING']);
      expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
      await statement(co, '500.00'); // a confirmed statement now exists: one issue resolves, the other rests on different evidence
      expect(await list(co).then((r) => r.json.issues.map((i: any) => [i.code, i.acceptance]))).toEqual([['OB_REFERENCE_MISSING', 'stale']]);
      await staleThenReaccept(co, ['OB_REFERENCE_MISSING']);
    });

    it('a linked document', async () => {
      const co = await setup('stDoc');
      const doc = (await h.q<{ id: string }>(
        "INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status) VALUES($1,$2,'stmt.pdf','application/pdf',10,$3,$4,'approved') RETURNING id",
        [co.id, co.owner.id, `k-${randomUUID()}`, 'a'.repeat(64)]))[0]!.id;
      await bankItem(co, '500.00', { bank_account_id: null, source_document_id: doc });
      await balance(co, '500.00');
      expect((await submit(co)).status).toBe(200);
      expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
      await h.q("UPDATE documents SET sha256=$2 WHERE id=$1", [doc, 'b'.repeat(64)]);
      await staleThenReaccept(co, ['OB_REFERENCE_MISSING']);
    });

    it('an accounting mapping', async () => {
      const co = await prepared('stMap');
      expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
      await h.q("UPDATE invoice_account_mappings SET account_id=$2 WHERE company_id=$1 AND mapping_key='receivable'", [co.id, co.other]);
      await staleThenReaccept(co, ['OB_SUBLEDGER_AGGREGATE_ONLY']);
    });

    it('a bank account currency', async () => {
      const co = await setup('stCur');
      const usd = await co.mkBank('Dollar', 'USD');
      await link(co, usd);
      await bankItem(co, '500.00', { bank_account_id: usd });
      await balance(co, '500.00');
      expect((await submit(co)).status).toBe(200);
      expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
      await h.q("UPDATE bank_accounts SET currency_code='EUR' WHERE id=$1", [usd]);
      await staleThenReaccept(co, ['OB_BANK_CURRENCY_NOT_COMPARABLE']);
    });
  });

  it('supersedes every live acceptance when the review returns to draft, and requires fresh acceptance after resubmission', async () => {
    const co = await prepared('ret');
    expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
    const back = await co.manager.client.req('POST', `/opening-balances/${co.fy}/return-to-draft`, { reason: 'Numbers need rework' });
    expect(back.status).toBe(200);
    const all = await rows(co);
    expect(all).toHaveLength(3);
    expect(all.map((x) => [x.status, x.end_reason])).toEqual(Array(3).fill(['superseded', 'review_returned_to_draft']));
    expect(all.every((x) => x.ended_by === co.manager.id && x.ended_at)).toBe(true);
    expect(await audits(co, 'opening_balance.exception.supersede')).toBe(3);
    const l = await list(co);
    expect(l.json).toMatchObject({ review_status: 'draft', accepted_unverified_count: 0 });
    expect(l.json.exceptions).toHaveLength(3);
    const dr = await post(co, [entry(l.json.issues[0])]);
    expect([dr.status, dr.json.code]).toEqual([409, 'OB_EXCEPTION_REVIEW_STATE']);
    const rd = await revoke(co, all[0].id, REASON);
    expect([rd.status, rd.json.code]).toEqual([409, 'OB_EXCEPTION_REVIEW_STATE']);
    const items = (await h.q<any>('SELECT id,version FROM opening_balance_items WHERE company_id=$1 AND category=\'equity\'', [co.id]))[0];
    expect((await patch(co, items, { note: 'reworked' })).status).toBe(200);
    expect((await submit(co)).status).toBe(200);
    const gate = await approve(co);
    expect([gate.status, gate.json.code]).toEqual([409, 'OPENING_BALANCE_EXCEPTIONS_REQUIRED']);
    expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
    expect((await approve(co)).status).toBe(200);
    expect((await rows(co)).map((x) => x.status)).toEqual(['superseded', 'superseded', 'superseded', 'active', 'active', 'active']);
  });

  it('lets exactly one of several concurrent identical acceptances win', async () => {
    const co = await prepared('conc');
    const bank = issueOf(await list(co), 'OB_BANK_AGGREGATE_ONLY');
    const who = [co.manager, co.owner, co.manager, co.owner, co.manager];
    const results = await Promise.all(who.map((u) => post(co, [entry(bank)], u)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.json.code).toBe('OB_EXCEPTION_ALREADY_ACTIVE');
    expect(await rows(co, "AND status='active'")).toHaveLength(1);
    expect(await audits(co, 'opening_balance.exception.accept')).toBe(1);
    // Concurrent revoke and approval: the approval sees either the acceptance (and posts) or its absence (and refuses), never a half state.
    const ar = issueOf(await list(co), 'OB_SUBLEDGER_AGGREGATE_ONLY');
    expect((await post(co, [entry(ar)])).status).toBe(201);
    const id = (await rows(co, "AND status='active' AND section='bank'"))[0].id;
    const [rv, ap] = await Promise.all([revoke(co, id, REASON), approve(co)]);
    if (ap.status === 200) { expect(await journals(co)).toBe(1); expect(rv.status).toBe(409); }
    else { expect([ap.status, ap.json.code]).toEqual([409, 'OPENING_BALANCE_EXCEPTIONS_REQUIRED']); expect(rv.status).toBe(200); expect(await journals(co)).toBe(0); }
  });

  it('leaves existing approved reviews and fully verified reviews untouched', async () => {
    const co = await setup('legacy');
    await link(co); await statement(co, '1000.00');
    await bankItem(co, '1000.00'); await balance(co, '1000.00');
    expect((await submit(co)).status).toBe(200);
    const l = await list(co);
    expect(l.json).toMatchObject({ reconciliation_status: 'verified', required_count: 0, exceptions: [], issues: [] });
    const done = await approve(co); // a verified review needs no acceptance, exactly as before
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(await rows(co)).toHaveLength(0);
    const after = await list(co);
    expect(after.status).toBe(200);
    expect(after.json).toMatchObject({ review_status: 'approved', exceptions: [] });
    const ev = (await h.q<any>("SELECT after_data FROM audit_log WHERE company_id=$1 AND action='opening_balance.approve'", [co.id]))[0].after_data;
    expect(ev.accepted_evidence_exceptions).toEqual([]);
    const snap = await snapshot(co);
    expect((await post(co, [{ issue_key: 'a'.repeat(64), evidence_fingerprint: 'b'.repeat(64), reason: REASON }])).status).toBe(409);
    expect(await snapshot(co)).toEqual(snap);
    expect((await list(await setup('noReview'))).status).toBe(404);
  });

  it('changes nothing in the ledger, the items or the evidence: acceptance, revocation and approval touch only the exceptions', async () => {
    const co = await prepared('acct', true);
    const before = await snapshot(co);
    const l = await list(co);
    expect((await post(co, (l.json.issues as any[]).map((i) => entry(i)))).status).toBe(201);
    const bank = (await rows(co)).find((x) => x.issue_code === 'OB_BANK_AGGREGATE_ONLY');
    expect((await revoke(co, bank.id, REASON)).status).toBe(200);
    expect(await snapshot(co)).toEqual(before);
    expect((await h.q<any>('SELECT DISTINCT source_type,confidence FROM opening_balance_items WHERE company_id=$1', [co.id]))).toEqual([{ source_type: 'internal_ledger', confidence: 'medium' }]);
    expect(await acceptAllIncomplete(co.manager.client, co.fy)).toMatchObject({ status: 201 });
    const done = await approve(co);
    expect(done.status).toBe(200);
    // The journal is built from the items alone, as before.
    const lines = await h.q<any>(`SELECT a.code,jl.debit::text,jl.credit::text FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.company_id=$1 ORDER BY a.code`, [co.id]);
    expect(lines).toEqual([
      { code: 'OB-AR', debit: '300.00', credit: '0.00' }, { code: 'OB-BANK', debit: '700.00', credit: '0.00' }, { code: 'OB-EQ', debit: '0.00', credit: '1000.00' },
    ]);
    expect(await journals(co)).toBe(1);
    expect((await h.q<any>('SELECT id,amount::text,version FROM opening_balance_items WHERE company_id=$1 ORDER BY id', [co.id])).map((x) => x.version)).toEqual([1, 1, 1]);
  });

  it('keeps the closed-period, closed-year and cut-over protections for acceptance and revocation', async () => {
    const period = await prepared('gPer');
    const id = (await post(period, [entry(issueOf(await list(period), 'OB_BANK_AGGREGATE_ONLY'))])).json.exceptions[0].id;
    await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-01-01','2026-01-31','closed')", [period.id, period.fy]);
    const a = await post(period, [entry(issueOf(await list(period), 'OB_SUBLEDGER_AGGREGATE_ONLY'))]);
    expect([a.status, a.json.code]).toEqual([409, 'ACCOUNTING_PERIOD_CLOSED']);
    const r = await revoke(period, id, REASON);
    expect([r.status, r.json.code]).toEqual([409, 'ACCOUNTING_PERIOD_CLOSED']);
    expect((await rows(period)).map((x) => x.status)).toEqual(['active']);

    const closed = await prepared('gYear');
    const issue = issueOf(await list(closed), 'OB_BANK_AGGREGATE_ONLY');
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [closed.fy]);
    const cy = await post(closed, [entry(issue)]);
    expect([cy.status, cy.json.code]).toEqual([409, 'FISCAL_YEAR_CLOSED']);
    expect(await rows(closed)).toHaveLength(0);

    const cut = await prepared('gCut');
    const cutIssue = issueOf(await list(cut), 'OB_BANK_AGGREGATE_ONLY');
    const { seedActiveAuthorityRange } = await import('./helpers/authority-fixture');
    await seedActiveAuthorityRange(h.db, cut.id, cut.owner.id, '2026-01-01', '2026-03-31');
    const ct = await post(cut, [entry(cutIssue)]);
    expect([ct.status, ct.json.code]).toEqual([409, 'ONBOARDING_PATH_CUTOVER_ACTIVE']);
    expect(await rows(cut)).toHaveLength(0);
    expect((await approve(cut)).status).toBe(409); // the existing cut-over guard still stops approval
    expect(await journals(cut)).toBe(0);
  });
});
