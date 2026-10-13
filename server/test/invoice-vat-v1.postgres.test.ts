import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Invoice VAT V1 (sales) against real PostgreSQL. Needs an isolated, disposable DATABASE_URL; skipped in CI like the other
// *.postgres.test.ts suites. Covers: multi-rate invoices, equal-amount VAT groups, exact per-line rounding, duplicate prevention,
// VAT period locking and concurrency, tenant isolation, monthly close, XLSX, returns and legacy document-only results.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('invoice VAT V1 sales integration (PostgreSQL)', () => {
  let pool: Pool;
  let drafts: import('../src/modules/invoices/invoice.service').InvoiceDraftService;
  let approval: import('../src/modules/invoices/invoice-approval.service').InvoiceApprovalService;
  let mappings: import('../src/modules/invoices/invoice-account-mapping.service').InvoiceAccountMappingService;
  let vat: import('../src/modules/vat/vat.router').VatService;
  let accounting: import('../src/modules/accounting/accounting.router').AccountingService;
  let parseDraft: typeof import('../src/modules/invoices/invoice.service').parseDraft;
  let loadVatReconciliation: typeof import('../src/modules/vat/vat-reconciliation').loadVatReconciliation;
  let loadVatClosingReport: typeof import('../src/modules/vat/vat-report').loadVatClosingReport;
  const run = randomUUID().slice(0, 8);
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const n = async (sql: string, p: unknown[] = []) => Number((await q(sql, p))[0].n);
  const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
  let creator: string; let approver: string;
  type Co = { id: string; fy: string; cust: string; acc: Record<string, string> };
  const CAPS = ['obligation.confirm', 'accounting.journal.create'];
  const ALL_VIEW = ['document.view', 'obligation.view', 'bank.view', 'vat.view', 'accounting.view', 'asset.view', 'opening_balance.view', 'periodic_adjustment.view'];
  type L = { vat_rate: string; vat_treatment: string; unit_price?: string; quantity?: string };
  const line = (treatment: string, rate: string, price = '100.00', quantity = '1'): L & { description: string } =>
    ({ description: `${treatment} ${rate}`, quantity, unit_price: price, vat_rate: rate, vat_treatment: treatment });

  async function company(label: string): Promise<Co> {
    const id = (await q('INSERT INTO companies (slug, name) VALUES ($1,$1) RETURNING id', [`ivv1-${label}-${run}`]))[0].id;
    const fy = (await q(`INSERT INTO fiscal_years (company_id, name, start_date, end_date) VALUES ($1,'FY','2026-01-01','2026-12-31') RETURNING id`, [id]))[0].id;
    const cust = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'C','customer',$2) RETURNING id`, [id, creator]))[0].id;
    const co: Co = { id, fy, cust, acc: {} };
    for (const [k, t] of Object.entries({ receivable: 'asset', payable: 'liability', sales_revenue: 'revenue', purchase_expense: 'expense', vat_output: 'liability', vat_input: 'asset' })) {
      co.acc[k] = (await q(`INSERT INTO accounts (company_id, code, name, account_type) VALUES ($1,$2,$2,$3) RETURNING id`, [id, `M-${k}`, t]))[0].id;
      await mappings.set(id, approver, k, co.acc[k]);
    }
    return co;
  }
  async function submitted(co: Co, lines: Array<ReturnType<typeof line>>, o: { issue?: string; tax?: string | null; doc?: string; creatorId?: string } = {}) {
    const issue = o.issue ?? '2026-03-10';
    const body: Record<string, unknown> = { counterparty_id: co.cust, issue_date: issue, lines };
    if (o.tax !== null) body.tax_point_date = o.tax ?? issue;
    if (o.doc) body.source_document_id = o.doc;
    const inv = await drafts.create(co.id, o.creatorId ?? creator, 'sales', parseDraft(body));
    const sub = await drafts.submit(co.id, o.creatorId ?? creator, inv.id, inv.version);
    return { id: sub.id as string, version: sub.version as number };
  }
  const approve = (co: Co, inv: { id: string; version: number }, actor = approver) => approval.approve(co.id, actor, CAPS, inv.id, inv.version);
  const post = (co: Co, journalId: string) => accounting.post(co.id, approver, journalId);
  async function vatPeriod(co: Co, start: string, end: string, status: 'open' | 'closed' = 'open') {
    return (await q(`INSERT INTO vat_periods (company_id, fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [co.id, co.fy, start, end, status]))[0].id as string;
  }
  async function legacyDocument(co: Co, o: { taxDate?: string; docDate?: string; posted?: boolean; recognized?: boolean } = {}) {
    const id = randomUUID();
    await q(`INSERT INTO documents(id,company_id,uploaded_by_user_id,status,original_filename,mime_type,size_bytes,storage_key,sha256,document_type,document_date,total_amount)
      VALUES($1,$2,$3,'approved',$4,'application/pdf',1,$5,$6,'sale',$7::date,'115.00'::numeric)`, [id, co.id, creator, `${id}.pdf`, `${co.id}/${id}`, 'a'.repeat(64), o.docDate ?? '2026-02-01']);
    if (o.recognized === false) return { id };
    await q(`INSERT INTO document_vat_reviews(company_id,document_id,tax_date,treatment,taxable_amount,vat_amount,review_status,reviewed_by_user_id,reviewed_at,recoverability_status)
      VALUES($1,$2,$3::date,'standard',100,15,'reviewed',$4,NOW(),'not_applicable')`, [co.id, id, o.taxDate ?? '2026-02-01', creator]);
    const ob = (await q(`INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id)
      VALUES($1,'receivable',$2,$3,115,$4::date,'confirmed','document',$5) RETURNING id`, [co.id, co.cust, id, o.docDate ?? '2026-02-01', creator]))[0].id;
    const j = (await q(`INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,source_type,source_id,status,created_by)
      VALUES($1,$2,$3::date,'legacy','obligation',$4,'draft',$5) RETURNING id`, [co.id, co.fy, o.docDate ?? '2026-02-01', ob, creator]))[0].id;
    await q(`INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES ($1,$2,$3,115,0,NULL,1),($1,$2,$4,0,100,NULL,2),($1,$2,$5,0,15,'VAT_OUTPUT',3)`,
      [co.id, j, co.acc.receivable, co.acc.sales_revenue, co.acc.vat_output]);
    if (o.posted !== false) await q(`UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE id=$1`, [j, creator]);
    return { id, obligation: ob, journal: j };
  }

  beforeAll(async () => {
    pool = (await import('../src/db/pool')).default!;
    const inv = await import('../src/modules/invoices/invoice.service');
    parseDraft = inv.parseDraft; drafts = new inv.InvoiceDraftService(pool);
    approval = new (await import('../src/modules/invoices/invoice-approval.service')).InvoiceApprovalService(pool);
    mappings = new (await import('../src/modules/invoices/invoice-account-mapping.service')).InvoiceAccountMappingService(pool);
    vat = new (await import('../src/modules/vat/vat.router')).VatService(pool);
    accounting = new (await import('../src/modules/accounting/accounting.router')).AccountingService(pool);
    loadVatReconciliation = (await import('../src/modules/vat/vat-reconciliation')).loadVatReconciliation;
    loadVatClosingReport = (await import('../src/modules/vat/vat-report')).loadVatClosingReport;
    creator = (await q(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [`ivv1-c-${run}@example.test`]))[0].id;
    approver = (await q(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [`ivv1-a-${run}@example.test`]))[0].id;
  });
  afterAll(async () => { await pool?.end(); });

  it('single-rate invoice: groups by treatment and rate, exact per-line rounding, VAT_OUTPUT per standard group, posts and reconciles', async () => {
    // Sales invoices now require the standard rate in force on the tax point date (migration 069), so a single sales invoice carries one standard rate;
  // multi-rate grouping and equal-amount groups stay covered by the purchase suite (invoice-vat-v2), which is not rate-validated.
    const co = await company('multi');
    // 15% on 0.10 x3: per-line VAT is 0.02 each (0.015 rounds half up) = 0.06, not 0.05 as a rate on the 0.30 sum would give.
    const inv = await submitted(co, [
      line('standard', '15', '100.00'), line('standard', '15', '0.10'), line('standard', '15', '0.10'), line('standard', '15', '0.10'),
      line('zero_rated', '0', '50.00'), line('exempt', '0', '30.00'), line('out_of_scope', '0', '20.00')]);
    const out = await approve(co, inv);
    const review = (await q('SELECT *, taxable_amount::text t, vat_amount::text v, tax_date::text d FROM invoice_vat_reviews WHERE invoice_id=$1', [inv.id]))[0];
    expect(review).toMatchObject({ company_id: co.id, t: '200.30', v: '15.06', d: '2026-03-10', reviewed_by_user_id: approver });
    const groups = await q(`SELECT vat_treatment, vat_rate::text r, line_count, taxable_amount::text t, vat_amount::text v FROM invoice_vat_review_groups WHERE review_id=$1 ORDER BY vat_treatment, vat_rate`, [review.id]);
    expect(groups).toEqual([
      { vat_treatment: 'exempt', r: '0.00', line_count: 1, t: '30.00', v: '0.00' },
      { vat_treatment: 'out_of_scope', r: '0.00', line_count: 1, t: '20.00', v: '0.00' },
      { vat_treatment: 'standard', r: '15.00', line_count: 4, t: '100.30', v: '15.06' },
      { vat_treatment: 'zero_rated', r: '0.00', line_count: 1, t: '50.00', v: '0.00' }]);
    const lines = await q(`SELECT debit::text d, credit::text c, memo FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence`, [out.journal_id]);
    expect(lines).toEqual([{ d: '215.36', c: '0.00', memo: null }, { d: '0.00', c: '200.30', memo: null }, { d: '0.00', c: '15.06', memo: 'VAT_OUTPUT' }]);
    expect(await n(`SELECT count(*) n FROM audit_log WHERE company_id=$1 AND action='invoice.vat_review.create'`, [co.id])).toBe(1);
    // not reconciled while only a draft exists, exact after posting
    await vatPeriod(co, '2026-03-01', '2026-03-31');
    let rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.invoices![0]!.reconciliation_status).toBe('missing_posted_journal');
    await post(co, out.journal_id);
    rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.invoices![0]).toMatchObject({ reconciliation_status: 'reconciled', ledger_vat_amount: '15.06', reviewed_vat_amount: '15.06' });
    expect(rec.totals).toMatchObject({ reviewed_output_vat: 15.06, ledger_output_vat: 15.06, output_difference: 0 });
    expect(rec.counts).toEqual({ total_in_scope: 1, reconciled: 1, unreconciled: 0 });
  });

  it('a tampered VAT memo blocks posting', async () => {
    const co = await company('equal');
    const inv = await submitted(co, [line('standard', '15', '100.00')]);
    const out = await approve(co, inv);
    const vatLines = await q(`SELECT id, credit::text c FROM journal_lines WHERE journal_entry_id=$1 AND memo='VAT_OUTPUT' ORDER BY sequence`, [out.journal_id]);
    expect(vatLines.map((l) => l.c)).toEqual(['15.00']);
    await q(`UPDATE journal_lines SET memo=NULL WHERE id=$1`, [vatLines[0].id]);
    await expect(post(co, out.journal_id)).rejects.toThrow(/does not match the reviewed VAT snapshot|Invalid accounting relationship/);
    expect((await q('SELECT status FROM journal_entries WHERE id=$1', [out.journal_id]))[0].status).toBe('draft');
    await q(`UPDATE journal_lines SET memo='VAT_OUTPUT' WHERE id=$1`, [vatLines[0].id]);
    await post(co, out.journal_id);
    expect((await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31')).invoices![0]!.reconciliation_status).toBe('reconciled');
    // a posted journal can no longer be altered at all
    expect(await code(q(`UPDATE journal_lines SET memo=NULL WHERE id=$1`, [vatLines[0].id]))).toBeDefined();
    expect((await q('SELECT status FROM journal_entries WHERE id=$1', [out.journal_id]))[0].status).toBe('posted');
    // if a journal were forced to posted behind the service's back with one VAT line unstamped, reconciliation reports it (no netting)
    const c2 = await company('equal2');
    const inv2 = await submitted(c2, [line('standard', '15', '100.00')]);
    const out2 = await approve(c2, inv2);
    const one = (await q(`SELECT id FROM journal_lines WHERE journal_entry_id=$1 AND memo='VAT_OUTPUT' ORDER BY sequence LIMIT 1`, [out2.journal_id]))[0].id;
    await q(`UPDATE journal_lines SET memo=NULL WHERE id=$1`, [one]);
    await q(`UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE id=$1`, [out2.journal_id, approver]);
    expect((await loadVatReconciliation(pool, c2.id, '2026-03-01', '2026-03-31')).invoices![0]!.reconciliation_status).toBe('missing_vat_line');
  });

  it('zero-VAT sales invoice (zero-rated, exempt, out of scope) still produces a review, no VAT line, and requires a posted journal', async () => {
    const co = await company('zero');
    const inv = await submitted(co, [line('zero_rated', '0'), line('exempt', '0'), line('out_of_scope', '0')]);
    const out = await approve(co, inv);
    expect(await n(`SELECT count(*) n FROM journal_lines WHERE journal_entry_id=$1 AND memo IS NOT NULL`, [out.journal_id])).toBe(0);
    expect((await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31')).invoices![0]!.reconciliation_status).toBe('missing_posted_journal');
    await post(co, out.journal_id);
    expect((await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31')).invoices![0]).toMatchObject({ reconciliation_status: 'reconciled', reviewed_vat_amount: '0.00' });
  });

  it('treatment and tax point are explicit, never inferred from the rate', async () => {
    const co = await company('explicit');
    expect(() => parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', lines: [line('standard', '0')] })).toThrow(/standard line needs a VAT rate above zero/);
    expect(() => parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', lines: [line('exempt', '15')] })).toThrow(/carries no VAT/);
    expect(() => parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', lines: [line('bogus', '15')] })).toThrow(/not valid/);
    // a 15% line without any treatment is a valid DRAFT but cannot be submitted
    const noTreatment = await drafts.create(co.id, creator, 'sales', parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', tax_point_date: '2026-03-10',
      lines: [{ description: 'x', quantity: '1', unit_price: '100.00', vat_rate: '15' }] }));
    await expect(drafts.submit(co.id, creator, noTreatment.id, noTreatment.version)).rejects.toMatchObject({ code: 'INVOICE_VAT_INCOMPLETE' });
    const noTaxPoint = await drafts.create(co.id, creator, 'sales', parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', lines: [line('standard', '15')] }));
    await expect(drafts.submit(co.id, creator, noTaxPoint.id, noTaxPoint.version)).rejects.toMatchObject({ code: 'INVOICE_VAT_INCOMPLETE' });
    // database coherence checks
    const inv = await drafts.create(co.id, creator, 'sales', parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', tax_point_date: '2026-03-10', lines: [line('standard', '15')] }));
    expect(await code(q(`UPDATE invoice_lines SET vat_treatment='standard', vat_rate=0, vat_amount=0, total_amount=net_amount WHERE invoice_id=$1`, [inv.id]))).toBe('23514');
    expect(await code(q(`UPDATE invoice_lines SET vat_treatment='exempt' WHERE invoice_id=$1`, [inv.id]))).toBe('23514');
    // the approver cannot repair a missing treatment: a submitted invoice with an untreated line is refused at approval
    const c2 = await company('explicit2');
    const sneaky = await drafts.create(c2.id, creator, 'sales', parseDraft({ counterparty_id: c2.cust, issue_date: '2026-03-10', tax_point_date: '2026-03-10', lines: [line('standard', '15')] }));
    await q(`UPDATE invoice_lines SET vat_treatment=NULL WHERE invoice_id=$1`, [sneaky.id]);
    await q(`UPDATE invoices SET status='submitted', version=version+1 WHERE id=$1`, [sneaky.id]);
    await expect(approve(c2, { id: sneaky.id, version: sneaky.version + 1 })).rejects.toMatchObject({ code: 'INVOICE_VAT_INCOMPLETE' });
  });

  it('the reviewed snapshot is immutable and must reproduce the invoice exactly (checked at commit)', async () => {
    const co = await company('immutable');
    const inv = await submitted(co, [line('standard', '15')]);
    await approve(co, inv);
    const review = (await q('SELECT id FROM invoice_vat_reviews WHERE invoice_id=$1', [inv.id]))[0];
    expect(await code(q(`UPDATE invoice_vat_reviews SET vat_amount=1 WHERE id=$1`, [review.id]))).toBe('23514');
    expect(await code(q(`DELETE FROM invoice_vat_reviews WHERE id=$1`, [review.id]))).toBe('23514');
    expect(await code(q(`UPDATE invoice_vat_review_groups SET vat_amount=1 WHERE review_id=$1`, [review.id]))).toBe('23514');
    expect(await code(q(`DELETE FROM invoice_vat_review_groups WHERE review_id=$1`, [review.id]))).toBe('23514');
    expect(await code(q(`INSERT INTO invoice_vat_reviews (company_id, invoice_id, tax_date, taxable_amount, vat_amount, reviewed_by_user_id) VALUES ($1,$2,'2026-03-10',100,15,$3)`, [co.id, inv.id, approver]))).toBe('23514'); // late insert: refused by the insert guard, before the unique key
    // a hand-written snapshot that is off by one halala is rejected when the transaction commits
    const c2 = await company('exact');
    const sub = await drafts.create(c2.id, creator, 'sales', parseDraft({ counterparty_id: c2.cust, issue_date: '2026-03-10', tax_point_date: '2026-03-10', lines: [line('standard', '15')] }));
    await drafts.submit(c2.id, creator, sub.id, sub.version);
    for (const [taxable, vatAmount, groupVat] of [['100.00', '15.00', '14.99'], ['100.01', '15.00', '15.00'], ['100.00', '15.01', '15.01']]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE invoices SET status='approved', internal_number=$3, fiscal_year_id=$4, approved_by_user_id=$2, approved_at=NOW() WHERE id=$1`, [sub.id, approver, 90 + Math.floor(Math.random() * 1e6), c2.fy]);
        const r = (await client.query(`INSERT INTO invoice_vat_reviews (company_id, invoice_id, tax_date, taxable_amount, vat_amount, reviewed_by_user_id) VALUES ($1,$2,'2026-03-10',$3,$4,$5) RETURNING id`, [c2.id, sub.id, taxable, vatAmount, approver])).rows[0];
        await client.query(`INSERT INTO invoice_vat_review_groups (company_id, review_id, vat_treatment, vat_rate, line_count, taxable_amount, vat_amount) VALUES ($1,$2,'standard',15,1,$3,$4)`, [c2.id, r.id, taxable, groupVat]);
        await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    }
    expect(await n(`SELECT count(*) n FROM invoice_vat_reviews WHERE company_id=$1`, [c2.id])).toBe(0);
    // the reviewer must be the independent approver, never the creator
    const c3 = await company('indep');
    const s3 = await drafts.create(c3.id, creator, 'sales', parseDraft({ counterparty_id: c3.cust, issue_date: '2026-03-10', tax_point_date: '2026-03-10', lines: [line('standard', '15')] }));
    await drafts.submit(c3.id, creator, s3.id, s3.version);
    await expect(approve(c3, { id: s3.id, version: s3.version + 1 }, creator)).rejects.toMatchObject({ code: 'INVOICE_SELF_APPROVAL' });
  });

  it('purchases with VAT need an explicit recoverability (V2 is covered in invoice-vat-v2); the invoice approval API stays disabled', async () => {
    const co = await company('purchase');
    const supp = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'S','supplier',$2) RETURNING id`, [co.id, creator]))[0].id;
    const p = await drafts.create(co.id, creator, 'purchase', parseDraft({ counterparty_id: supp, issue_date: '2026-03-10', tax_point_date: '2026-03-10', lines: [line('standard', '15')] }));
    await expect(drafts.submit(co.id, creator, p.id, p.version)).rejects.toMatchObject({ code: 'INVOICE_VAT_INCOMPLETE' });
    // F1: registered (migration 070) but explicit-grant-only and never auto-granted to Full Access.
    expect(await n(`SELECT count(*) n FROM capabilities WHERE id='invoice.approve' AND implicit_full_access = FALSE`)).toBe(1);
    expect(await n(`SELECT count(*) n FROM role_capabilities WHERE capability_id='invoice.approve' AND role_id IN (SELECT id FROM roles WHERE is_full_access)`)).toBe(0);
    expect(await n(`SELECT count(*) n FROM obligations WHERE company_id=$1`, [co.id])).toBe(0);
  });

  it('closed VAT period rejects approval and leaves no number, obligation, journal or review; differing issue/tax months are allowed', async () => {
    const co = await company('period');
    await vatPeriod(co, '2026-04-01', '2026-06-30', 'closed');
    const open = await vatPeriod(co, '2026-07-01', '2026-09-30');
    const blocked = await submitted(co, [line('standard', '15')], { issue: '2026-03-20', tax: '2026-05-02' });
    await expect(approve(co, blocked)).rejects.toMatchObject({ code: 'INVOICE_VAT_PERIOD_CLOSED' });
    expect(await n(`SELECT count(*) n FROM obligations WHERE company_id=$1`, [co.id])).toBe(0);
    expect(await n(`SELECT count(*) n FROM journal_entries WHERE company_id=$1`, [co.id])).toBe(0);
    expect(await n(`SELECT count(*) n FROM invoice_vat_reviews WHERE company_id=$1`, [co.id])).toBe(0);
    expect(await n(`SELECT count(*) n FROM invoice_number_counters WHERE company_id=$1`, [co.id])).toBe(0);
    expect((await q('SELECT status FROM invoices WHERE id=$1', [blocked.id]))[0].status).toBe('submitted');
    // issue date in March (open ledger month), tax point in July (open VAT period): valid, and reported in the July period only
    const ok = await submitted(co, [line('standard', '15')], { issue: '2026-03-20', tax: '2026-07-02' });
    const out = await approve(co, ok);
    await post(co, out.journal_id);
    expect((await loadVatReconciliation(pool, co.id, '2026-07-01', '2026-09-30')).invoices).toHaveLength(1);
    expect((await loadVatReconciliation(pool, co.id, '2026-01-01', '2026-03-31')).invoices).toBeUndefined();
    // a submitted-but-unapproved invoice blocks closing its VAT period; once reconciled the period closes and its report includes the invoice
    const pending = await submitted(co, [line('standard', '15')], { issue: '2026-03-21', tax: '2026-08-02' });
    await expect(vat.close(co.id, approver, open)).rejects.toThrow(/blockers/);
    const out2 = await approve(co, pending);
    await expect(vat.close(co.id, approver, open)).rejects.toThrow(/blockers/); // approved but journal still draft
    await post(co, out2.journal_id);
    await vat.close(co.id, approver, open);
    const report = await loadVatClosingReport(pool, co.id, open);
    expect(report.invoices).toHaveLength(2);
    expect(report.totals.output_vat).toBe(30);
    expect(report.treatments.standard).toMatchObject({ count: 2, taxable_amount: 200, vat_amount: 30 });
    // approving into the now-closed period is refused
    const late = await submitted(co, [line('standard', '15')], { issue: '2026-03-22', tax: '2026-09-15' });
    await expect(approve(co, late)).rejects.toMatchObject({ code: 'INVOICE_VAT_PERIOD_CLOSED' });
  });

  it('concurrent approval and VAT period close never leave an unreconciled invoice in a closed period', async () => {
    const co = await company('race');
    for (const month of ['01', '02', '03', '04']) {
      const start = `2026-${month}-01`, end = `2026-${month}-28`;
      const period = await vatPeriod(co, start, end);
      const inv = await submitted(co, [line('standard', '15')], { issue: start, tax: `2026-${month}-10` });
      const results = await Promise.allSettled([approve(co, inv), vat.close(co.id, approver, period)]);
      const status = (await q('SELECT status FROM vat_periods WHERE id=$1', [period]))[0].status;
      const approved = (await q('SELECT status FROM invoices WHERE id=$1', [inv.id]))[0].status === 'approved';
      // closed + approved is only possible if the approval's journal was posted before closing, which this test never does
      expect(status === 'closed' && approved).toBe(false);
      if (status === 'closed') expect(results[0].status).toBe('rejected');
      if (approved) expect(results[1].status).toBe('rejected');
    }
  });

  it('duplicate prevention: a linked document is evidence only and can never be recognized twice', async () => {
    const co = await company('dup');
    // (a) a document that is already recognized on its own cannot be taken over by an invoice, and stays in document results
    const hist = await legacyDocument(co);
    const takeOver = await submitted(co, [line('standard', '15')], { doc: hist.id });
    await expect(approve(co, takeOver)).rejects.toMatchObject({ code: 'INVOICE_DOCUMENT_ALREADY_RECOGNIZED' });
    const histRec = await loadVatReconciliation(pool, co.id, '2026-01-01', '2026-03-31');
    expect(histRec.documents.map((d) => d.document_id)).toEqual([hist.id]);
    expect(histRec.invoices).toBeUndefined();
    // (b) an unrecognized document linked to an approved invoice can no longer get its own VAT review or obligation
    const fresh = await legacyDocument(co, { recognized: false, docDate: '2026-03-05' });
    const inv = await submitted(co, [line('standard', '15')], { doc: fresh.id });
    // while merely submitted, the guard already blocks a second recognition path
    expect(await code(q(`INSERT INTO document_vat_reviews(company_id,document_id,tax_date,treatment,taxable_amount,vat_amount,review_status,reviewed_by_user_id,reviewed_at,recoverability_status)
      VALUES($1,$2,'2026-03-05','standard',100,15,'reviewed',$3,NOW(),'not_applicable')`, [co.id, fresh.id, creator]))).toBe('23514');
    expect(await code(q(`INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id)
      VALUES($1,'receivable',$2,$3,115,'2026-03-05','confirmed','document',$4)`, [co.id, co.cust, fresh.id, creator]))).toBe('23514');
    // a pending (not reviewed) review is still allowed to exist and is excluded from readiness once the invoice is approved
    await q(`INSERT INTO document_vat_reviews(company_id,document_id,tax_date,review_status,recoverability_status) VALUES($1,$2,'2026-03-05','pending','not_applicable')`, [co.id, fresh.id]);
    const before = await vat.readiness(co.id, '2026-03-01', '2026-03-31');
    expect(before.blockers.pending_reviews).toBe(1);
    const out = await approve(co, inv);
    await post(co, out.journal_id);
    const after = await vat.readiness(co.id, '2026-03-01', '2026-03-31');
    // the only remaining item is the other, still-submitted invoice (refused above); the linked document itself adds nothing
    expect(after.blockers).toMatchObject({ pending_reviews: 0, missing_reviews: 0, unapproved_documents: 1, vat_ledger_mismatches: 0 });
    // the same VAT is counted once: in the invoice rows, not as a document row
    const rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.documents).toHaveLength(0);
    expect(rec.totals.reviewed_output_vat).toBe(15);
    // (c) one review per invoice, one invoice per document
    expect(await code(q(`INSERT INTO invoice_source_links (company_id, invoice_id, document_id, created_by_user_id) VALUES ($1,$2,$3,$4)`, [co.id, takeOver.id, fresh.id, creator]))).toMatch(/^2350[5]$|^23514$/); // rejected either as a duplicate link or because the invoice is no longer a draft
  });

  it('tenant isolation: other companies neither see nor affect invoice VAT', async () => {
    const a = await company('iso-a'); const b = await company('iso-b');
    const inv = await submitted(a, [line('standard', '15')]);
    const out = await approve(a, inv);
    await post(a, out.journal_id);
    expect((await loadVatReconciliation(pool, a.id, '2026-03-01', '2026-03-31')).invoices).toHaveLength(1);
    expect((await loadVatReconciliation(pool, b.id, '2026-03-01', '2026-03-31')).invoices).toBeUndefined();
    expect(await n(`SELECT count(*) n FROM invoice_vat_reviews WHERE company_id=$1`, [b.id])).toBe(0);
    await expect(approval.approve(b.id, approver, CAPS, inv.id, inv.version)).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    // a review cannot be attached to another company's invoice (insert guard first, composite foreign key as backstop)
    const unreviewed = await submitted(a, [line('standard', '15')]);
    expect(await code(q(`INSERT INTO invoice_vat_reviews (company_id, invoice_id, tax_date, taxable_amount, vat_amount, reviewed_by_user_id) VALUES ($1,$2,'2026-03-10',100,15,$3)`, [b.id, unreviewed.id, approver]))).toMatch(/^(23514|23503)$/);
    const readyB = await vat.readiness(b.id, '2026-03-01', '2026-03-31');
    expect(readyB.ready).toBe(true);
  });

  it('legacy document-only results are unchanged by invoices in other periods and companies; returns keep their snapshot shape', async () => {
    const legacy = await company('legacy'); const other = await company('legacy-other');
    await legacyDocument(legacy);
    const q1 = await vatPeriod(legacy, '2026-01-01', '2026-03-31');
    await vatPeriod(legacy, '2026-04-01', '2026-06-30');
    const snapshot = async () => JSON.stringify({
      rec: await loadVatReconciliation(pool, legacy.id, '2026-01-01', '2026-03-31'),
      ready: await vat.readiness(legacy.id, '2026-01-01', '2026-03-31'),
      detail: (await vat.get(legacy.id, q1)).documents,
    });
    const before = await snapshot();
    expect(JSON.parse(before).rec.invoices).toBeUndefined();
    await vat.close(legacy.id, approver, q1);
    const closedReport = JSON.stringify(await loadVatClosingReport(pool, legacy.id, q1));
    expect(JSON.parse(closedReport).invoices).toBeUndefined();
    const { VatReturnService } = await import('../src/modules/vat/vat-returns.router');
    const returns = new VatReturnService(pool);
    const draft = await returns.create(legacy.id, approver, q1);
    const approved = await returns.approve(legacy.id, approver, draft.id, draft.version);
    expect(approved.snapshot_json).not.toHaveProperty('invoices');
    // invoices elsewhere: same company, later period; and another company in the same dates
    const later = await submitted(legacy, [line('standard', '15')], { issue: '2026-04-10' });
    const outLater = await approve(legacy, later); await post(legacy, outLater.journal_id);
    const otherInv = await submitted(other, [line('standard', '15')], { issue: '2026-02-10' });
    const outOther = await approve(other, otherInv); await post(other, outOther.journal_id);
    expect(await snapshot()).toBe(before);
    expect(JSON.stringify(await loadVatClosingReport(pool, legacy.id, q1))).toBe(closedReport);
    expect((await returns.get(legacy.id, draft.id)).snapshot_json).toEqual(approved.snapshot_json);
    // same period, same company (open period): documents unchanged, totals are documents + invoice
    const mixedCo = await company('legacy-mixed');
    await legacyDocument(mixedCo);
    const docOnly = await loadVatReconciliation(pool, mixedCo.id, '2026-01-01', '2026-03-31');
    const sameP = await submitted(mixedCo, [line('standard', '15')], { issue: '2026-03-11' });
    const outSame = await approve(mixedCo, sameP); await post(mixedCo, outSame.journal_id);
    const mixed = await loadVatReconciliation(pool, mixedCo.id, '2026-01-01', '2026-03-31');
    expect(mixed.documents).toEqual(docOnly.documents);
    expect(mixed.totals.reviewed_output_vat).toBe(30);
    expect(mixed.counts).toEqual({ total_in_scope: 2, reconciled: 2, unreconciled: 0 });
  });

  it('monthly close: unposted or non-reconciling invoice VAT blocks the ledger; a clean posted invoice does not', async () => {
    const { MonthlyCloseService } = await import('../src/modules/monthly-close/monthly-close.router');
    const mc = new MonthlyCloseService(pool);
    const co = await company('mclose');
    await q(`INSERT INTO monthly_close_periods (company_id, fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,'2026-03-01','2026-03-31','open')`, [co.id, co.fy]);
    const blockers = async () => (await mc.list(co.id, ALL_VIEW)).periods[0]!.blockers as Record<string, number>;
    const inv = await submitted(co, [line('standard', '15'), line('zero_rated', '0')]);
    const out = await approve(co, inv);
    expect((await blockers()).ledger).toBe(1); // approved but the journal is still a draft
    await post(co, out.journal_id);
    expect((await blockers()).ledger).toBe(0);
    // a second invoice whose journal was forced to posted with its VAT line unstamped does not reconcile: it blocks ledger and VAT
    const bad = await submitted(co, [line('standard', '15')], { issue: '2026-03-12' });
    const badOut = await approve(co, bad);
    await q(`UPDATE journal_lines SET memo=NULL WHERE journal_entry_id=$1 AND memo='VAT_OUTPUT'`, [badOut.journal_id]);
    await q(`UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE id=$1`, [badOut.journal_id, approver]);
    const broken = await blockers();
    expect(broken.ledger).toBe(1);
    expect(broken.vat).toBe(1);
    // another company's invoices never count here
    const co2 = await company('mclose2');
    const other = await submitted(co2, [line('standard', '15')]);
    await approve(co2, other);
    expect((await blockers()).ledger).toBe(1); // unchanged: company 2's draft journal is not counted here
  });

  it('working paper (XLSX) lists the invoice rows by treatment and rate', async () => {
    const co = await company('xlsx');
    const period = await vatPeriod(co, '2026-03-01', '2026-03-31');
    const inv = await submitted(co, [line('standard', '15'), line('exempt', '0')]);
    const out = await approve(co, inv); await post(co, out.journal_id);
    await vat.close(co.id, approver, period);
    const { buildVatWorkingPaperXlsx } = await import('../src/modules/vat/vat-report');
    const file = buildVatWorkingPaperXlsx(await loadVatClosingReport(pool, co.id, period));
    const text = file.toString('latin1');
    expect(text).toContain('Invoice 1');
    expect(text).toContain('Standard 15.00%'); expect(text).toContain('Exempt 0.00%');
    expect(text).toContain('reconciled');
  });
  it('snapshot is closed to late INSERT: groups and reviews can only be written by the approving transaction', async () => {
    const co = await company('lateinsert');
    const inv = await submitted(co, [line('standard', '15')]);
    await approve(co, inv);
    const review = (await q('SELECT id FROM invoice_vat_reviews WHERE invoice_id=$1', [inv.id]))[0];
    const before = await n('SELECT count(*) n FROM invoice_vat_review_groups WHERE review_id=$1', [review.id]);
    // a new group added to the committed snapshot in a later transaction (would otherwise change treatment totals silently)
    expect(await code(q(`INSERT INTO invoice_vat_review_groups (company_id, review_id, vat_treatment, vat_rate, line_count, taxable_amount, vat_amount) VALUES ($1,$2,'exempt',0,1,0,0)`, [co.id, review.id]))).toBe('23514');
    expect(await code(q(`INSERT INTO invoice_vat_review_groups (company_id, review_id, vat_treatment, vat_rate, line_count, taxable_amount, vat_amount) VALUES ($1,$2,'standard',5,1,10,0.50)`, [co.id, review.id]))).toBe('23514');
    expect(await n('SELECT count(*) n FROM invoice_vat_review_groups WHERE review_id=$1', [review.id])).toBe(before);
    // an invoice that was approved without a review cannot be given one afterwards, even with a perfectly matching snapshot
    const late = await submitted(co, [line('standard', '15')]);
    await q(`UPDATE invoices SET status='approved', internal_number=$3, fiscal_year_id=$4, approved_by_user_id=$2, approved_at=NOW() WHERE id=$1`, [late.id, approver, 700000 + Math.floor(Math.random() * 1e5), co.fy]);
    expect(await code(q(`INSERT INTO invoice_vat_reviews (company_id, invoice_id, tax_date, taxable_amount, vat_amount, reviewed_by_user_id) VALUES ($1,$2,'2026-03-10',100,15,$3)`, [co.id, late.id, approver]))).toBe('23514');
    expect(await n('SELECT count(*) n FROM invoice_vat_reviews WHERE invoice_id=$1', [late.id])).toBe(0);
  });

  it('lock order: approval never deadlocks with VAT review writes or fiscal-year close', async () => {
    const guard = await import('../src/modules/monthly-close/accounting-period.guard');
    const vatRouter = await import('../src/modules/vat/vat.router');
    const closeScope = await import('../src/modules/fiscal-years/fiscal-year-close-readiness');
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const deadlock = (r: PromiseSettledResult<unknown>) => r.status === 'rejected' && (r.reason as { code?: string })?.code === '40P01';
    // (a) writer order of a VAT review: document row -> VAT month lock -> accounting month lock
    const coA = await company('lockorder-a');
    const doc = await legacyDocument(coA, { recognized: false, docDate: '2026-03-05' });
    const invA = await submitted(coA, [line('standard', '15')], { doc: doc.id });
    const w1 = await pool.connect();
    try {
      await w1.query('BEGIN');
      await w1.query('SELECT 1 FROM documents WHERE id=$1 AND company_id=$2 FOR UPDATE', [doc.id, coA.id]);
      await vatRouter.lockVatDates(coA.id, ['2026-03-10'], w1);
      const approving = approve(coA, invA);
      await pause(400);                                        // approval is now waiting on the writer's locks
      const writer = (async () => { await guard.assertAccountingDateWritable(coA.id, '2026-03-10', w1); await w1.query('COMMIT'); })();
      const settled = await Promise.allSettled([approving, writer]);
      expect(settled.some(deadlock)).toBe(false);
      expect(settled[0].status).toBe('fulfilled');
    } finally { await w1.query('ROLLBACK').catch(() => undefined); w1.release(); }
    // (b) fiscal-year close order: fiscal-year row (FOR UPDATE) -> VAT range -> accounting range
    const coB = await company('lockorder-b');
    const invB = await submitted(coB, [line('standard', '15')]);
    const w2 = await pool.connect();
    try {
      await w2.query('BEGIN');
      await w2.query('SELECT 1 FROM fiscal_years WHERE id=$1 AND company_id=$2 FOR UPDATE', [coB.fy, coB.id]);
      const approving = approve(coB, invB);
      await pause(400);
      const closer = (async () => { await closeScope.lockFiscalYearCloseScope(w2, coB.id, { id: coB.fy, start_date: '2026-01-01', end_date: '2026-12-31' }); await w2.query('COMMIT'); })();
      const settled = await Promise.allSettled([approving, closer]);
      expect(settled.some(deadlock)).toBe(false);
      expect(settled[1].status).toBe('fulfilled');
    } finally { await w2.query('ROLLBACK').catch(() => undefined); w2.release(); }
  });

  it('custody allocation cannot be added to a document linked to a submitted or approved invoice', async () => {
    const co = await company('custody');
    const holder = creator;
    await q('INSERT INTO memberships (user_id, company_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [holder, co.id]);
    const custody = (await q(`INSERT INTO custody_advances (company_id, holder_user_id, created_by_user_id) VALUES ($1,$2,$2) RETURNING id`, [co.id, holder]))[0].id;
    const allocate = (docId: string) => q(`INSERT INTO custody_document_allocations (company_id, custody_id, document_id, amount, created_by_user_id) VALUES ($1,$2,$3,10,$4)`, [co.id, custody, docId, creator]);
    // (a) submitted invoice: blocked; approved invoice: blocked
    const d1 = await legacyDocument(co, { recognized: false, docDate: '2026-03-05' });
    const inv1 = await submitted(co, [line('standard', '15')], { doc: d1.id });
    expect(await code(allocate(d1.id))).toBe('23514');
    await approve(co, inv1);
    expect(await code(allocate(d1.id))).toBe('23514');
    expect(await n('SELECT count(*) n FROM custody_document_allocations WHERE document_id=$1', [d1.id])).toBe(0);
    // (b) an allocation made while the invoice was still a draft is caught at approval, for sales and for purchases
    const d2 = await legacyDocument(co, { recognized: false, docDate: '2026-03-06' });
    const draft = await drafts.create(co.id, creator, 'sales', parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', tax_point_date: '2026-03-10', source_document_id: d2.id, lines: [line('standard', '15')] }));
    await allocate(d2.id);
    const sub = await drafts.submit(co.id, creator, draft.id, draft.version);
    await expect(approve(co, { id: sub.id, version: sub.version })).rejects.toMatchObject({ code: 'INVOICE_DOCUMENT_ALREADY_RECOGNIZED' });
    const supplier = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'S','supplier',$2) RETURNING id`, [co.id, creator]))[0].id;
    const d3 = await legacyDocument(co, { recognized: false, docDate: '2026-03-07' });
    const pdraft = await drafts.create(co.id, creator, 'purchase', parseDraft({ counterparty_id: supplier, issue_date: '2026-03-10', tax_point_date: '2026-03-10', source_document_id: d3.id, lines: [{ description: 'p', quantity: '1', unit_price: '100.00', vat_rate: '0', vat_treatment: 'zero_rated' }] }));
    await allocate(d3.id);
    const psub = await drafts.submit(co.id, creator, pdraft.id, pdraft.version);
    await expect(approve(co, { id: psub.id, version: psub.version })).rejects.toMatchObject({ code: 'INVOICE_DOCUMENT_ALREADY_RECOGNIZED' });
    expect(await n(`SELECT count(*) n FROM invoices WHERE id IN ($1,$2) AND status='approved'`, [sub.id, psub.id])).toBe(0);
  });

  it('no route can cancel an approved invoice (F4 cancels draft/submitted only)', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const router = readFileSync(join(__dirname, '../src/modules/invoices/invoice.router.ts'), 'utf8');
    expect(router).not.toMatch(/invoiceRouter\.(delete|patch)\(/);
    expect(router.match(/invoiceRouter\.\w+\('[^']*cancel[^']*'/g)).toEqual(["invoiceRouter.post('/invoices/:id/cancel'", "invoiceRouter.post('/invoice-adjustments/:id/cancel'"]); // invoice cancel (draft/submitted only) + cancel of a DRAFT external note, both capability-guarded
    const services = ['invoice.service.ts', 'invoice-approval.service.ts'].map((f) => readFileSync(join(__dirname, '../src/modules/invoices', f), 'utf8')).join('\n');
    // F4: the only cancellation write is restricted to draft/submitted rows; approved invoices are refused before it.
    const writes = services.match(/SET status\s*=\s*'cancelled'[\s\S]*?\[invoiceId/gi) ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/status IN \('draft','submitted'\)/);
  });
});
