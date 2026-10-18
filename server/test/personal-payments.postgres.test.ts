import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { seedActiveAuthorityRange } from './helpers/authority-fixture';

// Personal expense payments and reimbursements over real HTTP + PostgreSQL (migration 089). Requires a disposable DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('personal payments (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  let rowNo = 0;

  async function setup(label: string) {
    const owner = await h.user(`${label}-own`);
    const preparer = await h.user(`${label}-prep`);       // create/edit drafts only
    const submitter = await h.user(`${label}-sub`);       // submit only
    const reviewer = await h.user(`${label}-rev`);        // approve/reject + audit history
    const reviewer2 = await h.user(`${label}-rev2`);      // approve/reject, no audit history
    const reimburser = await h.user(`${label}-rei`);      // reimburse only
    const payerMgr = await h.user(`${label}-pm`);         // payer identity and mapping only
    const viewer = await h.user(`${label}-view`);         // view only
    const employee = await h.user(`${label}-emp`);        // a company member the payer refers to
    const id = await h.company(label, owner.id);
    await h.member(id, preparer.id, ['personal_payment.view', 'personal_payment.create']);
    await h.member(id, submitter.id, ['personal_payment.view', 'personal_payment.submit']);
    await h.member(id, reviewer.id, ['personal_payment.view', 'personal_payment.review', 'personal_payment.audit.view']);
    await h.member(id, reviewer2.id, ['personal_payment.view', 'personal_payment.review']);
    await h.member(id, reimburser.id, ['personal_payment.view', 'personal_payment.reimburse']);
    await h.member(id, payerMgr.id, ['personal_payment.view', 'personal_payment.payer.manage']);
    await h.member(id, viewer.id, ['personal_payment.view']);
    await h.member(id, employee.id, ['personal_payment.view']);
    for (const u of [owner, preparer, submitter, reviewer, reviewer2, reimburser, payerMgr, viewer]) await u.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    const expense = await h.account(id, 'X-EXP', 'expense', 'operating_expense');
    const ap = await h.account(id, 'L-AP', 'liability', 'current_liability');
    const empPayable = await h.account(id, 'L-EMP', 'liability', 'current_liability');
    const currentA = await h.account(id, 'E-CUR-A', 'equity', 'equity');
    const bankGl = await h.account(id, 'B-BANK', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [bankGl]);
    const bank = (await h.q<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const batch = (await h.q<{ id: string }>(
      "INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id",
      [id, bank, `k-${randomUUID()}`, owner.id]))[0]!.id;
    await h.q("INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)", [id, bank, bankGl, owner.id]);
    const partnerA = (await h.q<{ id: string }>("INSERT INTO partners(company_id,name,created_by_user_id) VALUES($1,'Partner A',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const supplier = (await h.q<{ id: string }>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Supplier','supplier',$2) RETURNING id", [id, owner.id]))[0]!.id;
    return { id, owner, preparer, submitter, reviewer, reviewer2, reimburser, payerMgr, viewer, employee, fy, expense, ap, empPayable, currentA, bankGl, bank, batch, partnerA, supplier };
  }
  type Co = Awaited<ReturnType<typeof setup>>;

  async function employeePayer(co: Co, o: Record<string, unknown> = {}) {
    const r = await co.payerMgr.client.req('POST', '/personal-payments/payers', { display_name: 'Manager M', user_id: co.employee.id, payable_account_id: co.empPayable, ...o });
    expect(r.status).toBe(201);
    return r.json as { id: string; version: number };
  }
  async function partnerPayer(co: Co, o: Record<string, unknown> = {}) {
    await co.owner.client.req('PUT', `/partners/${co.partnerA}/account-mappings/current`, { account_id: co.currentA });
    const r = await co.payerMgr.client.req('POST', '/personal-payments/payers', { display_name: 'Partner A (manager)', partner_id: co.partnerA, ...o });
    expect(r.status).toBe(201);
    return r.json as { id: string; version: number };
  }
  async function doc(co: Co, total = '500.00', date = '2026-03-10', type = 'expense') {
    return (await h.q<{ id: string }>(
      `INSERT INTO documents(company_id,uploaded_by_user_id,status,original_filename,mime_type,size_bytes,storage_key,sha256,document_type,document_date,total_amount,counterparty_id)
       VALUES($1,$2,'approved','r.pdf','application/pdf',10,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [co.id, co.owner.id, `sk-${randomUUID()}`, 'a'.repeat(64), type, date, total, co.supplier]))[0]!.id;
  }
  async function bankTx(co: Co, date: string, amount: string) {
    rowNo += 1;
    return (await h.q<{ id: string }>(
      "INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,$4,$5,'SAR',$6,$7,'strong') RETURNING id",
      [co.id, co.bank, co.batch, date, amount, rowNo, `fp-${randomUUID()}`]))[0]!.id;
  }
  const body = (co: Co, payer: string, document: string, o: Record<string, unknown> = {}) => ({
    payer_id: payer, treatment: 'new_expense', payment_date: '2026-03-12', amount: '500.00', purpose: 'Client lunch', document_id: document, expense_account_id: co.expense, ...o,
  });
  async function draft(co: Co, b: Record<string, unknown>) {
    const r = await co.preparer.client.req('POST', '/personal-payments', b);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.payment as { id: string; version: number; status: string };
  }
  async function approved(co: Co, payer: string, o: Record<string, unknown> = {}, total = '500.00') {
    const d = await draft(co, body(co, payer, await doc(co, total), { amount: total, ...o }));
    expect((await co.submitter.client.req('POST', `/personal-payments/${d.id}/submit`, {})).status).toBe(200);
    const r = await co.reviewer.client.req('POST', `/personal-payments/${d.id}/approve`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return d.id;
  }
  const lines = (journal: string) => h.q<{ account_id: string; debit: string; credit: string; memo: string }>('SELECT account_id,debit::text,credit::text,memo FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence', [journal]);
  const reimburse = (co: Co, payment: string, bankTransactionId: string) => co.reimburser.client.req('POST', `/personal-payments/${payment}/reimbursements`, { bank_transaction_id: bankTransactionId });
  const journalCount = (co: Co, type: string) => h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type=$2', [co.id, type]);

  it('separates view, draft, submit, review, reimburse, payer management and audit history by capability', async () => {
    const co = await setup('auth');
    const payer = await employeePayer(co);
    const document = await doc(co);
    expect((await co.preparer.client.req('POST', '/personal-payments/payers', { display_name: 'X' })).status).toBe(403);
    expect((await co.viewer.client.req('POST', '/personal-payments', body(co, payer.id, document))).status).toBe(403);
    expect((await co.submitter.client.req('POST', '/personal-payments', body(co, payer.id, document))).status).toBe(403);
    const d = await draft(co, body(co, payer.id, document));
    expect((await co.preparer.client.req('POST', `/personal-payments/${d.id}/submit`, {})).status).toBe(403);
    expect((await co.submitter.client.req('POST', `/personal-payments/${d.id}/submit`, {})).status).toBe(200);
    expect((await co.submitter.client.req('POST', `/personal-payments/${d.id}/approve`, {})).status).toBe(403);
    expect((await co.preparer.client.req('POST', `/personal-payments/${d.id}/approve`, {})).status).toBe(403);
    expect((await co.viewer.client.req('POST', `/personal-payments/${d.id}/reject`, { reason: 'x' })).status).toBe(403);
    expect((await co.reimburser.client.req('POST', `/personal-payments/${d.id}/approve`, {})).status).toBe(403);
    expect((await co.reviewer2.client.req('POST', `/personal-payments/${d.id}/approve`, {})).status).toBe(200);
    expect((await co.viewer.client.req('POST', `/personal-payments/${d.id}/reimbursements`, { bank_transaction_id: randomUUID() })).status).toBe(403);
    expect((await co.reviewer.client.req('POST', `/personal-payments/${d.id}/reimbursements`, { bank_transaction_id: randomUUID() })).status).toBe(403);
    // view-only users read the register; financial/audit history needs its own capability
    const v = await co.viewer.client.req('GET', `/personal-payments/${d.id}`);
    expect(v.status).toBe(200);
    expect(v.json.history).toBeUndefined();
    expect(v.json.payment.journal_entry_id).toBeNull();
    expect((await co.reviewer2.client.req('GET', `/personal-payments/${d.id}`)).json.history).toBeUndefined();
    const full = await co.reviewer.client.req('GET', `/personal-payments/${d.id}`);
    expect(full.json.history.map((e: { event_type: string }) => e.event_type)).toEqual(['submitted', 'approved']);
    expect(full.json.payment.journal_entry_id).toBeTruthy();
    expect((await (await h.user('anon')).client.req('GET', '/personal-payments')).status).toBe(401);
    // Existing roles gain nothing automatically.
    expect(await h.count("SELECT COUNT(*)::text n FROM role_capabilities WHERE capability_id LIKE 'personal_payment.%' AND role_id IN (SELECT id FROM roles WHERE name IN ('Viewer','Accountant','Finance Manager'))")).toBe(0);
  });

  it('registers payers explicitly and rejects invalid, inactive, unknown and cross-company associations', async () => {
    const co = await setup('payer');
    const other = await setup('payer-other');
    const post = (b: Record<string, unknown>) => co.payerMgr.client.req('POST', '/personal-payments/payers', b);
    expect((await post({ display_name: 'A', partner_id: other.partnerA })).status).toBe(404);                              // other company's partner
    expect((await post({ display_name: 'A', partner_id: randomUUID() })).status).toBe(404);                                // unknown partner
    expect((await post({ display_name: 'A', payable_account_id: other.empPayable })).status).toBe(400);                    // other company's account
    expect((await post({ display_name: 'A', payable_account_id: co.expense })).status).toBe(400);                          // not a liability
    expect((await post({ display_name: 'A', partner_id: co.partnerA, payable_account_id: co.empPayable })).json.code).toBe('PERSONAL_PAYER_ONE_ACCOUNT_PATH');
    expect((await post({ display_name: 'A', user_id: other.employee.id })).json.code).toBe('PERSONAL_PAYER_USER_NOT_MEMBER');
    await h.q('UPDATE accounts SET is_active=false WHERE id=$1', [co.empPayable]);
    expect((await post({ display_name: 'A', payable_account_id: co.empPayable })).status).toBe(400);                       // inactive account
    await h.q('UPDATE accounts SET is_active=true WHERE id=$1', [co.empPayable]);
    await h.q('UPDATE partners SET is_active=false WHERE id=$1', [co.partnerA]);
    expect((await post({ display_name: 'A', partner_id: co.partnerA })).json.code).toBe('PARTNER_INACTIVE');
    await h.q('UPDATE partners SET is_active=true WHERE id=$1', [co.partnerA]);
    await employeePayer(co);
    expect((await post({ display_name: 'dup', user_id: co.employee.id })).json.code).toBe('PERSONAL_PAYER_DUPLICATE');
    await partnerPayer(co);
    expect((await post({ display_name: 'dup partner', partner_id: co.partnerA })).json.code).toBe('PERSONAL_PAYER_DUPLICATE');
    // a partner payer can never carry a parallel employee payable (database constraint)
    await expect(h.q('UPDATE personal_payers SET payable_account_id=$2 WHERE company_id=$1 AND partner_id IS NOT NULL', [co.id, co.empPayable])).rejects.toThrow(/one_account_path/);
    // an inactive payer cannot receive payments
    const p = await employeePayer(co, { display_name: 'Later', user_id: null });
    expect((await co.payerMgr.client.req('PATCH', `/personal-payments/payers/${p.id}`, { is_active: false, version: p.version })).status).toBe(200);
    expect((await co.preparer.client.req('POST', '/personal-payments', body(co, p.id, await doc(co)))).json.code).toBe('PERSONAL_PAYER_INACTIVE');
    // unknown / other-company payer on a payment
    const otherPayer = await employeePayer(other);
    expect((await co.preparer.client.req('POST', '/personal-payments', body(co, otherPayer.id, await doc(co)))).status).toBe(404);
    expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='personal_payer.create'", [co.id])).toBe(3);
  });

  it('SAR 500 from a non-partner manager: payable to the individual, balanced, attributable, audited', async () => {
    const co = await setup('emp');
    const payer = await employeePayer(co);
    const paymentId = await approved(co, payer.id);
    const p = (await h.q<{ status: string; journal_entry_id: string; debit_account_id: string; credit_account_id: string; accounting_date: string }>(
      'SELECT status,journal_entry_id,debit_account_id,credit_account_id,accounting_date::text FROM personal_payments WHERE id=$1', [paymentId]))[0]!;
    expect(p.status).toBe('approved');
    expect(p.accounting_date).toBe('2026-03-10');                       // the document date, like every other document-based recognition
    expect(await lines(p.journal_entry_id)).toEqual([
      { account_id: co.expense, debit: '500.00', credit: '0.00', memo: 'personal_payment' },
      { account_id: co.empPayable, debit: '0.00', credit: '500.00', memo: 'personal_payment' },
    ]);
    const j = (await h.q<{ status: string; source_type: string; source_id: string; accounting_date: string }>('SELECT status,source_type,source_id,accounting_date::text FROM journal_entries WHERE id=$1', [p.journal_entry_id]))[0]!;
    expect(j).toEqual({ status: 'posted', source_type: 'personal_payment', source_id: paymentId, accounting_date: '2026-03-10' });
    for (const a of ['personal_payment.create', 'personal_payment.submit', 'personal_payment.approve']) {
      expect(await h.count('SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action=$2 AND entity_id=$3', [co.id, a, paymentId])).toBe(1);
    }
    // a partner statement is untouched by a non-partner payer
    const ledger = await co.owner.client.req('GET', `/partners/${co.partnerA}/ledger?from=2026-01-01&to=2026-12-31`);
    expect(ledger.json.movements).toHaveLength(0);
    // payables view: SAR 500 outstanding to the employee payer
    const payables = await co.viewer.client.req('GET', '/personal-payments/payables?as_of=2026-12-31');
    expect(payables.json.payers).toEqual([expect.objectContaining({ payer_kind: 'employee', approved_amount: '500.00', reimbursed_amount: '0.00', outstanding_amount: '500.00' })]);
  });

  it('partner payer: credited to the partner current account exactly once in the statement, reimbursement reduces it', async () => {
    const co = await setup('partner');
    const payer = await partnerPayer(co);
    const paymentId = await approved(co, payer.id);
    const journal = (await h.q<{ journal_entry_id: string }>('SELECT journal_entry_id FROM personal_payments WHERE id=$1', [paymentId]))[0]!.journal_entry_id;
    const ls = await lines(journal);
    expect(ls.find((l) => l.credit === '500.00')!.account_id).toBe(co.currentA);       // never a parallel employee payable
    expect(ls.some((l) => l.account_id === co.empPayable)).toBe(false);
    let ledger = (await co.owner.client.req('GET', `/partners/${co.partnerA}/ledger?from=2026-01-01&to=2026-12-31`)).json;
    expect(ledger.movements.filter((m: { kind: string }) => m.kind === 'personal_payment')).toHaveLength(1);
    expect(ledger.classes.current).toMatchObject({ increases: '500.00', decreases: '0.00', closing_balance: '500.00' });
    // approving again (replay) never duplicates the statement row or the journal
    expect((await co.reviewer.client.req('POST', `/personal-payments/${paymentId}/approve`, {})).json.replayed).toBe(true);
    const bt = await bankTx(co, '2026-04-01', '-200.00');
    expect((await reimburse(co, paymentId, bt)).status).toBe(201);
    ledger = (await co.owner.client.req('GET', `/partners/${co.partnerA}/ledger?from=2026-01-01&to=2026-12-31`)).json;
    expect(ledger.movements.map((m: { kind: string }) => m.kind)).toEqual(['personal_payment', 'personal_reimbursement']);
    expect(ledger.classes.current).toMatchObject({ increases: '500.00', decreases: '200.00', closing_balance: '300.00' });
    const bal = (await co.owner.client.req('GET', '/partners/balances?as_of=2026-12-31')).json.partners;
    expect(bal).toEqual([expect.objectContaining({ partner_id: co.partnerA, current: '300.00', capital: '0.00', loan: '0.00' })]);
    expect(await journalCount(co, 'personal_payment')).toBe(1);
    // capital/loan classifications and existing partner transaction workflows are not touched
    expect(await h.count('SELECT COUNT(*)::text n FROM partner_transactions WHERE company_id=$1', [co.id])).toBe(0);
  });

  it('partner payer without a valid current-account mapping fails closed', async () => {
    const co = await setup('partner-nomap');
    const payer = (await co.payerMgr.client.req('POST', '/personal-payments/payers', { display_name: 'P', partner_id: co.partnerA })).json;
    const d = await draft(co, body(co, payer.id, await doc(co)));
    const r = await co.submitter.client.req('POST', `/personal-payments/${d.id}/submit`, {});
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('PERSONAL_PAYMENT_MAPPING_MISSING');
    // mapping present at submit, then withdrawn before approval: approval blocks and posts nothing
    await co.owner.client.req('PUT', `/partners/${co.partnerA}/account-mappings/current`, { account_id: co.currentA });
    expect((await co.submitter.client.req('POST', `/personal-payments/${d.id}/submit`, {})).status).toBe(200);
    await co.owner.client.req('DELETE', `/partners/${co.partnerA}/account-mappings/current`);
    const a = await co.reviewer.client.req('POST', `/personal-payments/${d.id}/approve`, {});
    expect(a.status).toBe(409);
    expect(a.json.code).toBe('PERSONAL_PAYMENT_MAPPING_MISSING');
    expect(await journalCount(co, 'personal_payment')).toBe(0);
    expect((await h.q<{ status: string }>('SELECT status FROM personal_payments WHERE id=$1', [d.id]))[0]!.status).toBe('submitted');
    // an inactive payable account on an employee payer also blocks
    const emp = await employeePayer(co);
    const d2 = await draft(co, body(co, emp.id, await doc(co)));
    await co.submitter.client.req('POST', `/personal-payments/${d2.id}/submit`, {});
    await h.q('UPDATE accounts SET is_active=false WHERE id=$1', [co.empPayable]);
    expect((await co.reviewer.client.req('POST', `/personal-payments/${d2.id}/approve`, {})).json.code).toBe('PERSONAL_PAYMENT_MAPPING_MISSING');
    expect(await journalCount(co, 'personal_payment')).toBe(0);
  });

  it('partial then final reimbursement of SAR 500: 200 leaves 300, 300 closes at zero, no expense is recognized again', async () => {
    const co = await setup('reimb');
    const payer = await employeePayer(co);
    const paymentId = await approved(co, payer.id);
    const expenseDebits = () => h.q<{ s: string }>('SELECT COALESCE(SUM(l.debit),0)::text s FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.company_id=$1 AND l.account_id=$2', [co.id, co.expense]).then((r) => r[0]!.s);
    expect(await expenseDebits()).toBe('500.00');
    const t1 = await bankTx(co, '2026-04-01', '-200.00');
    const r1 = await reimburse(co, paymentId, t1);
    expect(r1.status, JSON.stringify(r1.json)).toBe(201);
    expect(r1.json.payment).toMatchObject({ reimbursed_amount: '200.00', outstanding_amount: '300.00', settlement_status: 'partial' });
    const j1 = (await h.q<{ journal_entry_id: string }>('SELECT journal_entry_id FROM personal_payment_reimbursements WHERE bank_transaction_id=$1', [t1]))[0]!.journal_entry_id;
    expect(await lines(j1)).toEqual([
      { account_id: co.empPayable, debit: '200.00', credit: '0.00', memo: 'personal_payment_reimbursement' },
      { account_id: co.bankGl, debit: '0.00', credit: '200.00', memo: 'personal_payment_reimbursement' },
    ]);
    const t2 = await bankTx(co, '2026-04-15', '-300.00');
    const r2 = await reimburse(co, paymentId, t2);
    expect(r2.status).toBe(201);
    expect(r2.json.payment).toMatchObject({ reimbursed_amount: '500.00', outstanding_amount: '0.00', settlement_status: 'full' });
    expect(r2.json.reimbursements.map((r: { amount: string }) => r.amount)).toEqual(['200.00', '300.00']);
    expect(await expenseDebits()).toBe('500.00');                                         // no additional expense
    expect(await journalCount(co, 'personal_payment')).toBe(1);
    expect(await journalCount(co, 'personal_payment_reimbursement')).toBe(2);
    // payer account nets to zero: credit 500 (payment) - debit 500 (reimbursements)
    const net = (await h.q<{ n: string }>('SELECT (SUM(l.credit)-SUM(l.debit))::text n FROM journal_lines l WHERE l.company_id=$1 AND l.account_id=$2', [co.id, co.empPayable]))[0]!.n;
    expect(net).toBe('0.00');
    // nothing left to reimburse
    const t3 = await bankTx(co, '2026-05-01', '-1.00');
    expect((await reimburse(co, paymentId, t3)).json.code).toBe('PERSONAL_PAYMENT_OVER_REIMBURSEMENT');
    const payables = await co.viewer.client.req('GET', '/personal-payments/payables?as_of=2026-12-31');
    expect(payables.json.payers[0]).toMatchObject({ outstanding_amount: '0.00', open_payments: 0 });
    // as of 2026-04-10 only the first reimbursement counts
    expect((await co.viewer.client.req('GET', '/personal-payments/payables?as_of=2026-04-10')).json.payers[0].outstanding_amount).toBe('300.00');
    // the bank history shows both reimbursements and approved evidence cannot be altered
    await expect(h.q('UPDATE personal_payment_reimbursements SET amount=1 WHERE bank_transaction_id=$1', [t1])).rejects.toThrow(/immutable/);
    await expect(h.q('DELETE FROM personal_payment_reimbursements WHERE bank_transaction_id=$1', [t1])).rejects.toThrow(/cannot be deleted/);
  });

  it('refuses over-reimbursement, wrong direction, wrong dates, unmapped banks and already-explained bank transactions', async () => {
    const co = await setup('rules');
    const payer = await employeePayer(co);
    const paymentId = await approved(co, payer.id);
    expect((await reimburse(co, paymentId, await bankTx(co, '2026-04-01', '-500.01'))).json.code).toBe('PERSONAL_PAYMENT_OVER_REIMBURSEMENT');
    expect((await reimburse(co, paymentId, await bankTx(co, '2026-04-01', '200.00'))).json.code).toBe('PERSONAL_REIMBURSEMENT_BANK_MISMATCH');
    expect((await reimburse(co, paymentId, await bankTx(co, '2026-03-01', '-100.00'))).json.code).toBe('PERSONAL_REIMBURSEMENT_DATE_INVALID');
    const other = await setup('rules-other');
    expect((await reimburse(co, paymentId, await bankTx(other, '2026-04-01', '-100.00'))).status).toBe(404);   // another company's bank row
    // bank account with no ledger link on the date
    const bank2 = (await h.q<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Unlinked','SAR',$2) RETURNING id", [co.id, co.owner.id]))[0]!.id;
    const unlinked = (await h.q<{ id: string }>(
      "INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,'2026-04-01',-100,'SAR',9999,$4,'strong') RETURNING id",
      [co.id, bank2, co.batch, `fp-${randomUUID()}`]))[0]!.id;
    expect((await reimburse(co, paymentId, unlinked)).json.code).toBe('PERSONAL_PAYMENT_BANK_LEDGER_UNMAPPED');
    // explained elsewhere: obligation settlement, partner transaction
    const ob = (await h.q<{ id: string }>("INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,900,'2026-03-01','confirmed','manual',$3) RETURNING id", [co.id, co.supplier, co.owner.id]))[0]!.id;
    const settled = await bankTx(co, '2026-04-02', '-100.00');
    await h.q('INSERT INTO obligation_settlements(company_id,obligation_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,100,$4)', [co.id, ob, settled, co.owner.id]);
    expect((await reimburse(co, paymentId, settled)).json.code).toBe('PERSONAL_BANK_TRANSACTION_ALREADY_EXPLAINED');
    // a reimbursed bank row cannot later be settled, matched or used by a partner transaction (database backstops)
    const ok = await bankTx(co, '2026-04-03', '-100.00');
    expect((await reimburse(co, paymentId, ok)).status).toBe(201);
    await expect(h.q('INSERT INTO obligation_settlements(company_id,obligation_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,100,$4)', [co.id, ob, ok, co.owner.id])).rejects.toThrow(/already explained/);
    await expect(h.q("INSERT INTO partner_transactions(company_id,partner_id,transaction_type,transaction_date,amount,channel,bank_account_id,bank_transaction_id,created_by) VALUES($1,$2,'current_withdrawal','2026-04-03',100,'bank',$3,$4,$5)", [co.id, co.partnerA, co.bank, ok, co.owner.id])).rejects.toThrow(/already explained/);
    // a bank row explained by a partner transaction cannot reimburse
    const pt = await bankTx(co, '2026-04-04', '-100.00');
    await h.q("INSERT INTO partner_transactions(company_id,partner_id,transaction_type,transaction_date,amount,channel,bank_account_id,bank_transaction_id,created_by) VALUES($1,$2,'current_withdrawal','2026-04-04',100,'bank',$3,$4,$5)", [co.id, co.partnerA, co.bank, pt, co.owner.id]);
    expect((await reimburse(co, paymentId, pt)).json.code).toBe('PERSONAL_BANK_TRANSACTION_ALREADY_EXPLAINED');
    // an unapproved payment cannot be reimbursed
    const d = await draft(co, body(co, payer.id, await doc(co, '50.00'), { amount: '50.00' }));
    expect((await reimburse(co, d.id, await bankTx(co, '2026-04-05', '-50.00'))).json.code).toBe('PERSONAL_PAYMENT_NOT_APPROVED');
    // the candidate list excludes explained rows and amounts above the outstanding
    await bankTx(co, '2026-04-06', '-9999.00');
    const open = await co.reimburser.client.req('GET', `/personal-payments/${paymentId}/reimbursable-bank-transactions`);
    expect(open.status).toBe(200);
    expect(open.json.transactions.every((t: { id: string }) => ![settled, ok, pt].includes(t.id))).toBe(true);
    expect(open.json.transactions.every((t: { amount: string }) => Number(t.amount) <= 400)).toBe(true);
  });

  it('is idempotent and safe under concurrent approval and reimbursement', async () => {
    const co = await setup('conc');
    const payer = await employeePayer(co);
    const d = await draft(co, body(co, payer.id, await doc(co)));
    await co.submitter.client.req('POST', `/personal-payments/${d.id}/submit`, {});
    const approvals = await Promise.all([1, 2, 3].map(() => co.reviewer.client.req('POST', `/personal-payments/${d.id}/approve`, {})));
    expect(approvals.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(approvals.filter((r) => r.json.replayed === false)).toHaveLength(1);
    expect(await journalCount(co, 'personal_payment')).toBe(1);

    // the same bank row twice -> one reimbursement, the replay returns the same state
    const t = await bankTx(co, '2026-04-01', '-200.00');
    const same = await Promise.all([reimburse(co, d.id, t), reimburse(co, d.id, t)]);
    expect(same.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await h.count('SELECT COUNT(*)::text n FROM personal_payment_reimbursements WHERE payment_id=$1', [d.id])).toBe(1);
    expect(await journalCount(co, 'personal_payment_reimbursement')).toBe(1);

    // two different rows that together exceed the outstanding amount: exactly one wins (300 + 300 > 300 remaining)
    const a = await bankTx(co, '2026-04-02', '-300.00');
    const b = await bankTx(co, '2026-04-03', '-300.00');
    const race = await Promise.all([reimburse(co, d.id, a), reimburse(co, d.id, b)]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await h.q<{ s: string }>('SELECT SUM(amount)::text s FROM personal_payment_reimbursements WHERE payment_id=$1', [d.id]).then((r) => r[0]!.s)).toBe('500.00');

    // one bank row claimed by two different payments: exactly one wins
    const d2 = await approvedPayment(co, payer.id);
    const d3 = await approvedPayment(co, payer.id);
    const shared = await bankTx(co, '2026-05-01', '-100.00');
    const claim = await Promise.all([reimburse(co, d2, shared), reimburse(co, d3, shared)]);
    expect(claim.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await h.count('SELECT COUNT(*)::text n FROM personal_payment_reimbursements WHERE bank_transaction_id=$1', [shared])).toBe(1);

    // one document claimed by two concurrent drafts
    const sharedDoc = await doc(co);
    const drafts = await Promise.all([1, 2].map(() => co.preparer.client.req('POST', '/personal-payments', body(co, payer.id, sharedDoc))));
    expect(drafts.map((r) => r.status).sort()).toEqual([201, 409]);
  });
  async function approvedPayment(co: Co, payer: string) { return approved(co, payer); }

  it('existing obligation: reclassifies the recognized payable without a second expense, and the outstanding amount follows', async () => {
    const co = await setup('oblig');
    const payer = await employeePayer(co);
    const ob = (await h.q<{ id: string }>("INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,800,'2026-03-01','confirmed','manual',$3) RETURNING id", [co.id, co.supplier, co.owner.id]))[0]!.id;
    await h.postedJournal(co.id, co.fy, '2026-03-01', co.owner.id, [[co.expense, '800.00', '0.00'], [co.ap, '0.00', '800.00']], { source_type: 'obligation', source_id: ob });
    const lookups = await co.preparer.client.req('GET', '/personal-payments/lookups');
    expect(lookups.json.obligations).toEqual([expect.objectContaining({ id: ob, outstanding: '800.00' })]);
    const req = (o: Record<string, unknown>) => ({ payer_id: payer.id, treatment: 'existing_obligation', payment_date: '2026-03-20', amount: '500.00', purpose: 'Paid supplier personally', obligation_id: ob, ...o });
    expect((await co.preparer.client.req('POST', '/personal-payments', req({ amount: '800.01' }))).json.code).toBe('PERSONAL_PAYMENT_EXCEEDS_OUTSTANDING');
    expect((await co.preparer.client.req('POST', '/personal-payments', req({ payment_date: '2026-02-01' }))).json.code).toBe('PERSONAL_PAYMENT_DATE_INVALID');
    expect((await co.preparer.client.req('POST', '/personal-payments', req({ document_id: await doc(co) }))).status).toBe(400);
    const d = await draft(co, req({}));
    await co.submitter.client.req('POST', `/personal-payments/${d.id}/submit`, {});
    const a = await co.reviewer.client.req('POST', `/personal-payments/${d.id}/approve`, {});
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const journal = (await h.q<{ journal_entry_id: string }>('SELECT journal_entry_id FROM personal_payments WHERE id=$1', [d.id]))[0]!.journal_entry_id;
    expect(await lines(journal)).toEqual([
      { account_id: co.ap, debit: '500.00', credit: '0.00', memo: 'personal_payment' },        // the account the obligation was credited
      { account_id: co.empPayable, debit: '0.00', credit: '500.00', memo: 'personal_payment' },
    ]);
    expect(await h.q<{ s: string }>('SELECT COALESCE(SUM(l.debit),0)::text s FROM journal_lines l WHERE l.company_id=$1 AND l.account_id=$2', [co.id, co.expense]).then((r) => r[0]!.s)).toBe('800.00');   // expense unchanged
    // every outstanding calculation (aging, obligations, snapshots) sees SAR 300
    expect((await h.q<{ n: string }>('SELECT obligation_adjustment_net($1,$2)::text n', [ob, co.id]))[0]!.n).toBe('-500.00');
    expect(Number((await h.q<{ n: string }>('SELECT obligation_adjustment_net($1,$2,$3::date)::text n', [ob, co.id, '2026-03-10']))[0]!.n)).toBe(0);
    const aging = await co.owner.client.req('GET', '/obligations/aging?as_of_date=2026-12-31');
    expect(JSON.stringify(aging.json)).toContain('300.00');
    // the remaining SAR 300 cannot be exceeded by a bank settlement or a second personal payment
    const t = await bankTx(co, '2026-04-01', '-301.00');
    await expect(h.q('INSERT INTO obligation_settlements(company_id,obligation_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,301,$4)', [co.id, ob, t, co.owner.id])).rejects.toThrow(/exceeds/);
    expect((await co.preparer.client.req('POST', '/personal-payments', req({ amount: '300.01' }))).json.code).toBe('PERSONAL_PAYMENT_EXCEEDS_OUTSTANDING');
    // the obligation cannot be cancelled or un-confirmed while reclassified
    await expect(h.q('UPDATE obligations SET is_cancelled=true WHERE id=$1', [ob])).rejects.toThrow(/reclassified/);
    await expect(h.q("UPDATE obligations SET verification_status='unconfirmed' WHERE id=$1", [ob])).rejects.toThrow(/reclassified/);
    // full outstanding can still be reclassified; reimbursement then settles the individual payable only
    const d2 = await draft(co, req({ amount: '300.00' }));
    await co.submitter.client.req('POST', `/personal-payments/${d2.id}/submit`, {});
    expect((await co.reviewer.client.req('POST', `/personal-payments/${d2.id}/approve`, {})).status).toBe(200);
    expect((await h.q<{ n: string }>('SELECT obligation_adjustment_net($1,$2)::text n', [ob, co.id]))[0]!.n).toBe('-800.00');
    expect((await reimburse(co, d.id, await bankTx(co, '2026-04-02', '-500.00'))).status).toBe(201);
    expect(await journalCount(co, 'personal_payment')).toBe(2);
  });

  it('refuses unsupported, mismatched and already-recognized source documents', async () => {
    const co = await setup('docs');
    const payer = await employeePayer(co);
    const create = (b: Record<string, unknown>) => co.preparer.client.req('POST', '/personal-payments', b);
    expect((await create(body(co, payer.id, await doc(co, '500.00'), { amount: '499.00' }))).json.code).toBe('PERSONAL_PAYMENT_DOCUMENT_AMOUNT_MISMATCH');
    expect((await create(body(co, payer.id, await doc(co, '500.00', '2026-03-10', 'purchase')))).json.code).toBe('PERSONAL_PAYMENT_DOCUMENT_NOT_ELIGIBLE');
    const unapproved = await doc(co);
    await h.q("UPDATE documents SET status='needs_review' WHERE id=$1", [unapproved]);
    expect((await create(body(co, payer.id, unapproved))).json.code).toBe('PERSONAL_PAYMENT_DOCUMENT_NOT_ELIGIBLE');
    expect((await create(body(co, payer.id, randomUUID()))).status).toBe(404);
    const other = await setup('docs-other');
    expect((await create(body(co, payer.id, await doc(other)))).status).toBe(404);                       // another company's document
    expect((await create(body(co, payer.id, await doc(co), { expense_account_id: co.empPayable }))).json.code).toBe('PERSONAL_PAYMENT_ACCOUNT_TYPE');
    expect((await create(body(co, payer.id, await doc(co), { expense_account_id: other.expense }))).status).toBe(400);
    expect((await create(body(co, payer.id, await doc(co), { expense_account_id: undefined }))).status).toBe(400);

    // reviewed VAT is never recognized here: it must come through the invoice/obligation path
    const withVat = await doc(co);
    await h.q("INSERT INTO document_vat_reviews(company_id,document_id,tax_date,review_status,treatment,taxable_amount,vat_amount,reviewed_by_user_id,reviewed_at,recoverability_status,recoverable_vat_amount) VALUES($1,$2,'2026-03-10','reviewed','standard',434.78,65.22,$3,now(),'fully_recoverable',65.22)", [co.id, withVat, co.owner.id]);
    expect((await create(body(co, payer.id, withVat))).json.code).toBe('PERSONAL_PAYMENT_VAT_UNSUPPORTED');
    const pending = await doc(co);
    await h.q("INSERT INTO document_vat_reviews(company_id,document_id,tax_date,review_status,recoverability_status) VALUES($1,$2,'2026-03-10','pending','needs_review')", [co.id, pending]);
    expect((await create(body(co, payer.id, pending))).json.code).toBe('PERSONAL_PAYMENT_VAT_UNSUPPORTED');
    const zeroVat = await doc(co);
    await h.q("INSERT INTO document_vat_reviews(company_id,document_id,tax_date,review_status,treatment,taxable_amount,vat_amount,reviewed_by_user_id,reviewed_at,recoverability_status) VALUES($1,$2,'2026-03-10','reviewed','out_of_scope',500,0,$3,now(),'not_applicable')", [co.id, zeroVat, co.owner.id]);
    expect((await create(body(co, payer.id, zeroVat))).status).toBe(201);

    // already recognized: obligation, custody allocation, bank settlement, another personal payment
    const viaObligation = await doc(co);
    await h.q("INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,$3,500,'2026-03-10','unconfirmed','document',$4)", [co.id, co.supplier, viaObligation, co.owner.id]);
    expect((await create(body(co, payer.id, viaObligation))).json.code).toBe('PERSONAL_PAYMENT_DOCUMENT_ALREADY_RECOGNIZED');
    const viaCustody = await doc(co);
    const custody = (await h.q<{ id: string }>('INSERT INTO custody_advances(company_id,holder_user_id,created_by_user_id) VALUES($1,$2,$2) RETURNING id', [co.id, co.owner.id]))[0]!.id;
    await h.q('INSERT INTO custody_document_allocations(company_id,custody_id,document_id,amount,created_by_user_id) VALUES($1,$2,$3,500,$4)', [co.id, custody, viaCustody, co.owner.id]);
    expect((await create(body(co, payer.id, viaCustody))).json.code).toBe('PERSONAL_PAYMENT_DOCUMENT_ALREADY_RECOGNIZED');
    const mine = await doc(co);
    const first = await draft(co, body(co, payer.id, mine));
    expect((await create(body(co, payer.id, mine))).json.code).toBe('PERSONAL_PAYMENT_DOCUMENT_ALREADY_RECOGNIZED');
    // the reverse direction: other workflows cannot take a document a live personal payment holds (database triggers)
    await expect(h.q("INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,$3,500,'2026-03-10','unconfirmed','document',$4)", [co.id, co.supplier, mine, co.owner.id])).rejects.toThrow(/personal payment/);
    await expect(h.q('INSERT INTO custody_document_allocations(company_id,custody_id,document_id,amount,created_by_user_id) VALUES($1,$2,$3,500,$4)', [co.id, custody, mine, co.owner.id])).rejects.toThrow(/personal payment/);
    // a rejected payment releases its document
    await co.submitter.client.req('POST', `/personal-payments/${first.id}/submit`, {});
    expect((await co.reviewer.client.req('POST', `/personal-payments/${first.id}/reject`, { reason: 'wrong' })).status).toBe(200);
    expect((await create(body(co, payer.id, mine))).status).toBe(201);
    expect((await co.preparer.client.req('POST', `/personal-payments/${first.id}/reopen`, {})).json.code).toBe('PERSONAL_PAYMENT_DOCUMENT_ALREADY_RECOGNIZED');
  });

  it('rejection and correction keep the evidence; approved and submitted records are immutable', async () => {
    const co = await setup('flow');
    const payer = await employeePayer(co);
    const d = await draft(co, body(co, payer.id, await doc(co)));
    expect((await co.preparer.client.req('PATCH', `/personal-payments/${d.id}`, { ...body(co, payer.id, await doc(co)), version: 99 })).json.code).toBe('PERSONAL_PAYMENT_VERSION_CONFLICT');
    const edited = await co.preparer.client.req('PATCH', `/personal-payments/${d.id}`, { ...body(co, payer.id, await doc(co), { purpose: 'Edited' }), version: d.version });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect((await co.reviewer.client.req('POST', `/personal-payments/${d.id}/approve`, {})).json.code).toBe('PERSONAL_PAYMENT_NOT_SUBMITTED');
    expect((await co.submitter.client.req('POST', `/personal-payments/${d.id}/submit`, {})).status).toBe(200);
    // submitted: no edits, no deletes, even straight in SQL
    expect((await co.preparer.client.req('PATCH', `/personal-payments/${d.id}`, { ...body(co, payer.id, await doc(co)), version: edited.json.payment.version + 1 })).json.code).toBe('PERSONAL_PAYMENT_NOT_DRAFT');
    expect((await co.preparer.client.req('DELETE', `/personal-payments/${d.id}?version=1`)).json.code).toBe('PERSONAL_PAYMENT_NOT_DRAFT');
    await expect(h.q("UPDATE personal_payments SET amount=1 WHERE id=$1", [d.id])).rejects.toThrow(/cannot be edited/);
    await expect(h.q('DELETE FROM personal_payments WHERE id=$1', [d.id])).rejects.toThrow(/cannot be deleted/);
    // reject needs a reason
    expect((await co.reviewer.client.req('POST', `/personal-payments/${d.id}/reject`, { reason: '' })).status).toBe(400);
    expect((await co.reviewer.client.req('POST', `/personal-payments/${d.id}/reject`, {})).status).toBe(400);
    const rej = await co.reviewer.client.req('POST', `/personal-payments/${d.id}/reject`, { reason: 'Receipt unreadable' });
    expect(rej.json.payment).toMatchObject({ status: 'rejected', rejection_reason: 'Receipt unreadable' });
    expect(await journalCount(co, 'personal_payment')).toBe(0);
    expect((await co.reviewer.client.req('POST', `/personal-payments/${d.id}/approve`, {})).json.code).toBe('PERSONAL_PAYMENT_NOT_SUBMITTED');
    await expect(h.q("UPDATE personal_payments SET purpose='x' WHERE id=$1", [d.id])).rejects.toThrow(/reopened as a draft/);
    // correction: reopen, fix, resubmit, approve; the history keeps every step
    expect((await co.viewer.client.req('POST', `/personal-payments/${d.id}/reopen`, {})).status).toBe(403);
    expect((await co.preparer.client.req('POST', `/personal-payments/${d.id}/reopen`, {})).json.payment.status).toBe('draft');
    expect((await co.submitter.client.req('POST', `/personal-payments/${d.id}/submit`, {})).status).toBe(200);
    expect((await co.reviewer.client.req('POST', `/personal-payments/${d.id}/approve`, {})).status).toBe(200);
    const history = (await co.reviewer.client.req('GET', `/personal-payments/${d.id}`)).json.history.map((e: { event_type: string }) => e.event_type);
    expect(history).toEqual(['submitted', 'rejected', 'reopened', 'submitted', 'approved']);
    // approved: immutable and not deletable; events are append-only; a reopened draft with history cannot be deleted
    await expect(h.q("UPDATE personal_payments SET purpose='x' WHERE id=$1", [d.id])).rejects.toThrow(/immutable/);
    await expect(h.q("UPDATE personal_payments SET status='draft' WHERE id=$1", [d.id])).rejects.toThrow(/immutable/);
    await expect(h.q('DELETE FROM personal_payments WHERE id=$1', [d.id])).rejects.toThrow(/cannot be deleted/);
    await expect(h.q("UPDATE personal_payment_events SET reason='x' WHERE payment_id=$1", [d.id])).rejects.toThrow(/append-only/);
    await expect(h.q('DELETE FROM personal_payment_events WHERE payment_id=$1', [d.id])).rejects.toThrow(/append-only/);
    expect((await co.preparer.client.req('POST', `/personal-payments/${d.id}/reopen`, {})).json.code).toBe('PERSONAL_PAYMENT_NOT_REJECTED');
    const audit = await h.q<{ action: string }>("SELECT action FROM audit_log WHERE company_id=$1 AND entity_id=$2 ORDER BY created_at, id", [co.id, d.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['personal_payment.create', 'personal_payment.update', 'personal_payment.submit', 'personal_payment.reject', 'personal_payment.reopen', 'personal_payment.approve']));
    // a draft that never entered review can be deleted
    const fresh = await draft(co, body(co, payer.id, await doc(co)));
    expect((await co.preparer.client.req('DELETE', `/personal-payments/${fresh.id}?version=${fresh.version}`)).status).toBe(204);
  });

  it('enforces closed fiscal years, closed monthly periods and external source-authority ranges', async () => {
    const co = await setup('period');
    const payer = await employeePayer(co);
    const d = await draft(co, body(co, payer.id, await doc(co)));
    await co.submitter.client.req('POST', `/personal-payments/${d.id}/submit`, {});
    await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-03-01','2026-03-31','closed')", [co.id, co.fy]);
    const closed = await co.reviewer.client.req('POST', `/personal-payments/${d.id}/approve`, {});
    expect(closed.status).toBe(409);
    expect(closed.json.code).toBe('PERSONAL_PAYMENT_PERIOD_CLOSED');
    expect(await journalCount(co, 'personal_payment')).toBe(0);
    expect((await co.preparer.client.req('POST', '/personal-payments', body(co, payer.id, await doc(co)))).json.code).toBe('PERSONAL_PAYMENT_PERIOD_CLOSED');
    await h.q("UPDATE monthly_close_periods SET status='open' WHERE company_id=$1", [co.id]);
    await seedActiveAuthorityRange(h.db, co.id, co.owner.id, '2026-03-01', '2026-03-31');
    const external = await co.reviewer.client.req('POST', `/personal-payments/${d.id}/approve`, {});
    expect(external.status).toBe(409);
    expect(JSON.stringify(external.json)).toMatch(/AUTHORITY|external/i);
    expect(await journalCount(co, 'personal_payment')).toBe(0);
    // closed fiscal year
    const co2 = await setup('period2');
    const payer2 = await employeePayer(co2);
    const d2 = await draft(co2, body(co2, payer2.id, await doc(co2)));
    await co2.submitter.client.req('POST', `/personal-payments/${d2.id}/submit`, {});
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [co2.fy]);
    expect((await co2.reviewer.client.req('POST', `/personal-payments/${d2.id}/approve`, {})).json.code).toBe('PERSONAL_PAYMENT_FISCAL_YEAR_CLOSED');
    // a closed period also blocks a reimbursement dated in it
    const co3 = await setup('period3');
    const payer3 = await employeePayer(co3);
    const id3 = await approved(co3, payer3.id);
    await h.q("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-04-01','2026-04-30','closed')", [co3.id, co3.fy]);
    const r = await reimburse(co3, id3, await bankTx(co3, '2026-04-10', '-100.00'));
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('PERSONAL_PAYMENT_PERIOD_CLOSED');
    expect(await journalCount(co3, 'personal_payment_reimbursement')).toBe(0);
    expect(await h.count('SELECT COUNT(*)::text n FROM personal_payment_reimbursements WHERE payment_id=$1', [id3])).toBe(0);
  });

  it('isolates tenants: no cross-company reads or writes of payments, payers, documents, bank rows or mappings', async () => {
    const a = await setup('iso-a');
    const b = await setup('iso-b');
    const payerA = await employeePayer(a);
    const idA = await approved(a, payerA.id);
    for (const [method, url, payload] of [
      ['GET', `/personal-payments/${idA}`], ['POST', `/personal-payments/${idA}/approve`, {}], ['POST', `/personal-payments/${idA}/reject`, { reason: 'x' }],
      ['POST', `/personal-payments/${idA}/reopen`, {}], ['POST', `/personal-payments/${idA}/submit`, {}], ['PATCH', `/personal-payments/payers/${payerA.id}`, { is_active: false, version: 1 }],
      ['GET', `/personal-payments/${idA}/reimbursable-bank-transactions`],
    ] as const) {
      const r = await b.owner.client.req(method, url, payload);
      expect([403, 404, 409], `${method} ${url} -> ${r.status}`).toContain(r.status);
      expect(r.status === 409 ? r.json.code : '').not.toBe('PERSONAL_PAYMENT_OK');
    }
    expect((await b.owner.client.req('GET', '/personal-payments')).json.payments).toHaveLength(0);
    expect((await b.owner.client.req('GET', '/personal-payments/payers')).json.payers).toHaveLength(0);
    expect((await b.owner.client.req('GET', '/personal-payments/payables?as_of=2026-12-31')).json.payers).toHaveLength(0);
    expect((await b.owner.client.req('POST', `/personal-payments/${idA}/reimbursements`, { bank_transaction_id: await bankTx(b, '2026-04-01', '-100.00') })).status).toBe(404);
    expect(await h.count('SELECT COUNT(*)::text n FROM personal_payment_reimbursements WHERE company_id=$1', [a.id])).toBe(0);
    // database-level cross-company references are impossible (composite foreign keys)
    await expect(h.q("UPDATE personal_payers SET partner_id=$2 WHERE id=$1", [payerA.id, b.partnerA])).rejects.toThrow();
    // company A's reimbursement list never leaks company B's bank rows, and vice versa
    const listA = await a.reimburser.client.req('GET', `/personal-payments/${idA}/reimbursable-bank-transactions`);
    expect(listA.json.transactions).toHaveLength(0);
  });

  it('journal contract: hand-made personal payment journals and manual creation are refused', async () => {
    const co = await setup('contract');
    const payer = await employeePayer(co);
    const d = await draft(co, body(co, payer.id, await doc(co)));
    await co.submitter.client.req('POST', `/personal-payments/${d.id}/submit`, {});
    // a hand-made journal pointing at the submitted payment cannot be posted with arbitrary accounts
    await h.q("UPDATE personal_payments SET debit_account_id=$2, credit_account_id=$3 WHERE id=$1", [d.id, co.expense, co.ap]);
    const j = (await h.q<{ id: string }>(
      "INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,source_type,source_id,entry_type,created_by) VALUES($1,$2,'2026-03-10','hand','personal_payment',$3,'standard',$4) RETURNING id",
      [co.id, co.fy, d.id, co.owner.id]))[0]!.id;
    await h.q('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,500,0,1),($1,$2,$4,0,500,2)', [co.id, j, co.expense, co.ap]);
    const post = await co.owner.client.req('POST', `/journals/${j}/post`, {});
    expect([400, 409]).toContain(post.status);
    expect((await h.q<{ status: string }>('SELECT status FROM journal_entries WHERE id=$1', [j]))[0]!.status).toBe('draft');
    const manual = await co.owner.client.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: '2026-03-10', description: 'x', source_type: 'personal_payment', source_id: d.id, lines: [] });
    expect([400, 403, 404, 409]).toContain(manual.status);
  });

  it('closing integration: pending payments block the month, recognized documents satisfy ledger coverage, reimbursed bank rows are resolved', async () => {
    const co = await setup('close');
    const payer = await employeePayer(co);
    const document = await doc(co);
    const d = await draft(co, body(co, payer.id, document));
    const count = (sql: string) => h.count(sql, [co.id]);
    const pendingSql = "SELECT COUNT(*)::text n FROM personal_payments pp WHERE pp.company_id=$1 AND pp.status IN ('draft','submitted') AND pp.accounting_date BETWEEN '2026-03-01' AND '2026-03-31'";
    expect(await count(pendingSql)).toBe(1);
    const svc = await import('../src/modules/monthly-close/monthly-close.router');
    const readiness = async () => {
      const service = new svc.MonthlyCloseService(h.db);
      return (service as unknown as { blockers: (c: string, f: string, s: string, e: string) => Promise<Record<string, number>> }).blockers(co.id, co.fy, '2026-03-01', '2026-03-31');
    };
    let blockers = await readiness();
    expect(blockers['obligations']).toBe(1);                      // the draft payment
    expect(blockers['ledger']).toBeGreaterThan(0);                // the approved document has no recognition yet
    await co.submitter.client.req('POST', `/personal-payments/${d.id}/submit`, {});
    expect((await readiness())['obligations']).toBe(1);           // still pending review
    await co.reviewer.client.req('POST', `/personal-payments/${d.id}/approve`, {});
    blockers = await readiness();
    expect(blockers['obligations']).toBe(0);
    expect(blockers['ledger']).toBe(0);                           // posted personal payment is a valid recognition path for the expense document
    // the reimbursed bank row is resolved, an unexplained one is not
    const resolved = await bankTx(co, '2026-03-20', '-100.00');
    const unresolved = await bankTx(co, '2026-03-21', '-50.00');
    expect((await readiness())['bank_transactions']).toBe(2);
    expect((await reimburse(co, d.id, resolved)).status).toBe(201);
    expect((await readiness())['bank_transactions']).toBe(1);
    expect(unresolved).toBeTruthy();
  });
});
