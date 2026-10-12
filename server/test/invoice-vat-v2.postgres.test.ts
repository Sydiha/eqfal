import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Invoice VAT V2 (purchases) against real PostgreSQL. Needs an isolated, disposable DATABASE_URL; skipped in CI like the other
// *.postgres.test.ts suites. Covers input VAT: explicit recoverability, VAT_INPUT lines, exact rounding, mixed sales/purchases,
// reports, returns, XLSX, monthly close, duplicate prevention, tenant isolation, cross-period dates and concurrency.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('invoice VAT V2 purchase integration (PostgreSQL)', () => {
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
  type Co = { id: string; fy: string; cust: string; supp: string; acc: Record<string, string> };
  const CAPS = ['obligation.confirm', 'accounting.journal.create'];
  const ALL_VIEW = ['document.view', 'obligation.view', 'bank.view', 'vat.view', 'accounting.view', 'asset.view', 'opening_balance.view', 'periodic_adjustment.view'];
  type L = { vat_rate: string; vat_treatment: string; unit_price?: string; quantity?: string; vat_recoverability?: string };
  // Purchase lines: standard lines state full recovery explicitly (the only supported value in V2).
  const line = (treatment: string, rate: string, price = '100.00', quantity = '1'): L & { description: string } =>
    ({ description: `${treatment} ${rate}`, quantity, unit_price: price, vat_rate: rate, vat_treatment: treatment, ...(treatment === 'standard' ? { vat_recoverability: 'fully_recoverable' } : {}) });

  async function company(label: string): Promise<Co> {
    const id = (await q('INSERT INTO companies (slug, name) VALUES ($1,$1) RETURNING id', [`ivv2-${label}-${run}`]))[0].id;
    const fy = (await q(`INSERT INTO fiscal_years (company_id, name, start_date, end_date) VALUES ($1,'FY','2026-01-01','2026-12-31') RETURNING id`, [id]))[0].id;
    const cust = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'C','customer',$2) RETURNING id`, [id, creator]))[0].id;
    const supp = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'S','supplier',$2) RETURNING id`, [id, creator]))[0].id;
    const co: Co = { id, fy, cust, supp, acc: {} };
    for (const [k, t] of Object.entries({ receivable: 'asset', payable: 'liability', sales_revenue: 'revenue', purchase_expense: 'expense', vat_output: 'liability', vat_input: 'asset' })) {
      co.acc[k] = (await q(`INSERT INTO accounts (company_id, code, name, account_type) VALUES ($1,$2,$2,$3) RETURNING id`, [id, `M-${k}`, t]))[0].id;
      await mappings.set(id, approver, k, co.acc[k]);
    }
    return co;
  }
  async function submitted(co: Co, lines: Array<ReturnType<typeof line>>, o: { issue?: string; tax?: string | null; doc?: string; creatorId?: string; direction?: 'sales' | 'purchase' } = {}) {
    const issue = o.issue ?? '2026-03-10';
    const direction = o.direction ?? 'purchase';
    const body: Record<string, unknown> = { counterparty_id: direction === 'sales' ? co.cust : co.supp, issue_date: issue,
      lines: direction === 'sales' ? lines.map(({ vat_recoverability: _r, ...l }) => l) : lines };
    if (o.tax !== null) body.tax_point_date = o.tax ?? issue;
    if (o.doc) body.source_document_id = o.doc;
    const inv = await drafts.create(co.id, o.creatorId ?? creator, direction, parseDraft(body));
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
      VALUES($1,$2,$3,'approved',$4,'application/pdf',1,$5,$6,'purchase',$7::date,'115.00'::numeric)`, [id, co.id, creator, `${id}.pdf`, `${co.id}/${id}`, 'a'.repeat(64), o.docDate ?? '2026-02-01']);
    if (o.recognized === false) return { id };
    await q(`INSERT INTO document_vat_reviews(company_id,document_id,tax_date,treatment,taxable_amount,vat_amount,review_status,reviewed_by_user_id,reviewed_at,recoverability_status)
      VALUES($1,$2,$3::date,'standard',100,15,'reviewed',$4,NOW(),'fully_recoverable')`, [co.id, id, o.taxDate ?? '2026-02-01', creator]);
    await q(`UPDATE document_vat_reviews SET recoverable_vat_amount=15, recoverability_reviewed_by_user_id=$2, recoverability_reviewed_at=NOW() WHERE document_id=$1`, [id, creator]);
    const ob = (await q(`INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id)
      VALUES($1,'payable',$2,$3,115,$4::date,'confirmed','document',$5) RETURNING id`, [co.id, co.supp, id, o.docDate ?? '2026-02-01', creator]))[0].id;
    const j = (await q(`INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,source_type,source_id,status,created_by)
      VALUES($1,$2,$3::date,'legacy','obligation',$4,'draft',$5) RETURNING id`, [co.id, co.fy, o.docDate ?? '2026-02-01', ob, creator]))[0].id;
    await q(`INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES ($1,$2,$3,100,0,NULL,1),($1,$2,$4,15,0,'VAT_INPUT',2),($1,$2,$5,0,115,NULL,3)`,
      [co.id, j, co.acc.purchase_expense, co.acc.vat_input, co.acc.payable]);
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
    creator = (await q(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [`ivv2-c-${run}@example.test`]))[0].id;
    approver = (await q(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [`ivv2-a-${run}@example.test`]))[0].id;
  });
  afterAll(async () => { await pool?.end(); });

  it('multi-rate purchase: groups by treatment and rate, exact per-line rounding, VAT_INPUT debit per standard group, posts and reconciles as input VAT', async () => {
    const co = await company('multi');
    const inv = await submitted(co, [
      line('standard', '15', '100.00'), line('standard', '5', '200.00'), line('standard', '15', '0.10'), line('standard', '15', '0.10'), line('standard', '15', '0.10'),
      line('zero_rated', '0', '50.00'), line('exempt', '0', '30.00'), line('out_of_scope', '0', '20.00')]);
    const out = await approve(co, inv);
    const review = (await q('SELECT *, taxable_amount::text t, vat_amount::text v, recoverable_vat_amount::text rv, tax_date::text d FROM invoice_vat_reviews WHERE invoice_id=$1', [inv.id]))[0];
    expect(review).toMatchObject({ direction: 'purchase', t: '400.30', v: '25.06', rv: '25.06', d: '2026-03-10', reviewed_by_user_id: approver });
    const groups = await q(`SELECT vat_treatment, vat_rate::text r, line_count, taxable_amount::text t, vat_amount::text v, recoverable_vat_amount::text rv FROM invoice_vat_review_groups WHERE review_id=$1 ORDER BY vat_treatment, vat_rate`, [review.id]);
    expect(groups).toEqual([
      { vat_treatment: 'exempt', r: '0.00', line_count: 1, t: '30.00', v: '0.00', rv: '0.00' },
      { vat_treatment: 'out_of_scope', r: '0.00', line_count: 1, t: '20.00', v: '0.00', rv: '0.00' },
      { vat_treatment: 'standard', r: '5.00', line_count: 1, t: '200.00', v: '10.00', rv: '10.00' },
      { vat_treatment: 'standard', r: '15.00', line_count: 4, t: '100.30', v: '15.06', rv: '15.06' },
      { vat_treatment: 'zero_rated', r: '0.00', line_count: 1, t: '50.00', v: '0.00', rv: '0.00' }]);
    const lines = await q(`SELECT account_id a, debit::text d, credit::text c, memo FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence`, [out.journal_id]);
    expect(lines).toEqual([
      { a: co.acc.purchase_expense, d: '400.30', c: '0.00', memo: null }, { a: co.acc.vat_input, d: '10.00', c: '0.00', memo: 'VAT_INPUT' },
      { a: co.acc.vat_input, d: '15.06', c: '0.00', memo: 'VAT_INPUT' }, { a: co.acc.payable, d: '0.00', c: '425.36', memo: null }]);
    expect((await q('SELECT direction FROM obligations WHERE id=$1', [out.obligation_id]))[0].direction).toBe('payable');
    let rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.invoices![0]).toMatchObject({ reconciliation_status: 'missing_posted_journal', expected_memo: 'VAT_INPUT', direction: 'purchase' });
    await post(co, out.journal_id);
    rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.invoices![0]).toMatchObject({ reconciliation_status: 'reconciled', ledger_vat_amount: '25.06', reviewed_vat_amount: '25.06', recoverable_vat_amount: '25.06' });
    // input, never output
    expect(rec.totals).toMatchObject({ reviewed_output_vat: 0, ledger_output_vat: 0, reviewed_input_vat: 25.06, gross_reviewed_input_vat: 25.06,
      recoverable_input_vat: 25.06, non_recoverable_input_vat: 0, ledger_input_vat: 25.06, input_difference: 0 });
    expect(rec.counts).toEqual({ total_in_scope: 1, reconciled: 1, unreconciled: 0 });
  });

  it('mixed sales and purchases in one period: output and input stay separate, net VAT is exact; sales rows keep their V1 shape', async () => {
    const co = await company('mixed');
    const period = await vatPeriod(co, '2026-03-01', '2026-03-31');
    const s = await submitted(co, [line('standard', '15', '1000.00'), line('zero_rated', '0', '100.00')], { direction: 'sales' });
    const p = await submitted(co, [line('standard', '15', '200.00'), line('standard', '5', '100.00'), line('exempt', '0', '40.00')]);
    for (const inv of [s, p]) { const out = await approve(co, inv); await post(co, out.journal_id); }
    await vat.close(co.id, approver, period);
    const report = await loadVatClosingReport(pool, co.id, period);
    expect(report.totals).toMatchObject({ output_vat: 150, input_vat: 35, net_vat: 115, sales_total: 1250, purchase_expense_total: 375, recoverable_input_vat: 35, non_recoverable_input_vat: 0, fully_recoverable_documents: 1 });
    expect(report.treatments.standard).toMatchObject({ count: 2, taxable_amount: 1300, vat_amount: 185 });
    expect(report.treatments.exempt).toMatchObject({ count: 1, taxable_amount: 40 });
    const sale = report.invoices!.find((i) => i.expected_memo === 'VAT_OUTPUT')!;
    expect(sale).not.toHaveProperty('direction'); expect(sale).not.toHaveProperty('recoverable_vat_amount');
    expect(sale.groups.every((g) => !('recoverable_vat_amount' in g))).toBe(true);
    expect(report.reconciliation.counts).toEqual({ total_in_scope: 2, reconciled: 2, unreconciled: 0 });
    expect((await vat.readiness(co.id, '2026-03-01', '2026-03-31')).ready).toBe(true);
    // returns snapshot the purchase too, immutably
    const { VatReturnService } = await import('../src/modules/vat/vat-returns.router');
    const returns = new VatReturnService(pool);
    const draft = await returns.create(co.id, approver, period);
    const approved = await returns.approve(co.id, approver, draft.id, draft.version);
    expect((approved.snapshot_json as { totals: { input_vat: number } }).totals.input_vat).toBe(35);
    expect(await code(q(`UPDATE vat_returns SET snapshot_json='{}'::jsonb WHERE id=$1`, [draft.id]))).not.toBe('ok');
    // working paper: purchase rows by treatment and rate, with full recovery
    const { buildVatWorkingPaperXlsx } = await import('../src/modules/vat/vat-report');
    const text = buildVatWorkingPaperXlsx(report).toString('latin1');
    expect(text).toContain('Standard 5.00%'); expect(text).toContain('fully_recoverable'); expect(text).toContain('VAT_INPUT');
  });

  it('recoverability is explicit and never defaulted (non-full recovery is covered by the V2.1 suite)', async () => {
    const co = await company('recov');
    // missing recoverability on a standard purchase line: valid draft, cannot be submitted
    const missing = await drafts.create(co.id, creator, 'purchase', parseDraft({ counterparty_id: co.supp, issue_date: '2026-03-10', tax_point_date: '2026-03-10',
      lines: [{ description: 'x', quantity: '1', unit_price: '100.00', vat_rate: '15', vat_treatment: 'standard' }] }));
    await expect(drafts.submit(co.id, creator, missing.id, missing.version)).rejects.toMatchObject({ code: 'INVOICE_VAT_INCOMPLETE' });
    // values outside the approved set (e.g. a UI-style 'needs_review') are rejected, never defaulted
    expect(() => parseDraft({ counterparty_id: co.supp, issue_date: '2026-03-10', lines: [{ ...line('standard', '15'), vat_recoverability: 'needs_review' }] })).toThrow(/not valid/);
    expect(() => parseDraft({ counterparty_id: co.supp, issue_date: '2026-03-10', lines: [{ ...line('exempt', '0'), vat_recoverability: 'fully_recoverable' }] })).toThrow(/only to a standard line/);
    // sales lines never carry recoverability
    await expect(drafts.create(co.id, creator, 'sales', parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', tax_point_date: '2026-03-10', lines: [line('standard', '15')] })))
      .rejects.toMatchObject({ code: 'INVOICE_VALIDATION' });
    expect(await code(q(`UPDATE invoice_lines SET vat_recoverability='partially_recoverable' WHERE invoice_id=$1`, [missing.id]))).toBe('23514'); // partial needs an explicit percent
    // missing tax point date
    const noTax = await drafts.create(co.id, creator, 'purchase', parseDraft({ counterparty_id: co.supp, issue_date: '2026-03-10', lines: [line('standard', '15')] }));
    await expect(drafts.submit(co.id, creator, noTax.id, noTax.version)).rejects.toMatchObject({ code: 'INVOICE_VAT_INCOMPLETE' });
    // the approver cannot repair it either: a submitted purchase whose recoverability was removed is refused, and nothing is written
    // (submitted lines are immutable, so the gap is created on the draft and the status forced behind the service's back)
    const sneaky = await drafts.create(co.id, creator, 'purchase', parseDraft({ counterparty_id: co.supp, issue_date: '2026-03-10', tax_point_date: '2026-03-10', lines: [line('standard', '15')] }));
    await q(`UPDATE invoice_lines SET vat_recoverability=NULL WHERE invoice_id=$1`, [sneaky.id]);
    await q(`UPDATE invoices SET status='submitted', version=version+1 WHERE id=$1`, [sneaky.id]);
    await expect(approve(co, { id: sneaky.id, version: sneaky.version + 1 })).rejects.toMatchObject({ code: 'INVOICE_VAT_INCOMPLETE' });
    expect(await n(`SELECT count(*) n FROM obligations WHERE company_id=$1`, [co.id])).toBe(0);
  });

  it('snapshot is immutable, exact and direction-consistent; independent approval enforced', async () => {
    const co = await company('immutable');
    const inv = await submitted(co, [line('standard', '15')]);
    await approve(co, inv);
    const review = (await q('SELECT id FROM invoice_vat_reviews WHERE invoice_id=$1', [inv.id]))[0];
    expect(await code(q(`UPDATE invoice_vat_reviews SET recoverable_vat_amount=0 WHERE id=$1`, [review.id]))).toBe('23514');
    expect(await code(q(`UPDATE invoice_vat_review_groups SET recoverable_vat_amount=0 WHERE review_id=$1`, [review.id]))).toBe('23514');
    expect(await code(q(`DELETE FROM invoice_vat_reviews WHERE id=$1`, [review.id]))).toBe('23514');
    expect(await code(q(`INSERT INTO invoice_vat_review_groups (company_id, review_id, vat_treatment, vat_rate, line_count, taxable_amount, vat_amount, recoverable_vat_amount) VALUES ($1,$2,'exempt',0,1,0,0,0)`, [co.id, review.id]))).toBe('23514');
    // hand-written snapshots: wrong direction, partial recovery, off-by-one halala, missing recoverable amount -> refused at commit or by constraints
    const c2 = await company('exact');
    const sub = await submitted(c2, [line('standard', '15')]);
    const attempts: Array<[string, string, string | null, string | null]> = [['sales', '15.00', null, null], ['purchase', '15.00', '14.99', '14.99'], ['purchase', '15.00', '15.00', '14.99'], ['purchase', '15.00', null, '15.00']];
    for (const [dir, groupVat, headerRec, groupRec] of attempts) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE invoices SET status='approved', internal_number=$3, fiscal_year_id=$4, approved_by_user_id=$2, approved_at=NOW() WHERE id=$1`, [sub.id, approver, 90 + Math.floor(Math.random() * 1e6), c2.fy]);
        const r = (await client.query(`INSERT INTO invoice_vat_reviews (company_id, invoice_id, direction, tax_date, taxable_amount, vat_amount, reviewed_by_user_id, recoverable_vat_amount) VALUES ($1,$2,$3,'2026-03-10',100,15,$4,$5) RETURNING id`, [c2.id, sub.id, dir, approver, headerRec])).rows[0];
        await client.query(`INSERT INTO invoice_vat_review_groups (company_id, review_id, vat_treatment, vat_rate, line_count, taxable_amount, vat_amount, recoverable_vat_amount) VALUES ($1,$2,'standard',15,1,100,$3,$4)`, [c2.id, r.id, groupVat, groupRec]);
        await client.query('COMMIT');
        throw new Error(`accepted ${dir} ${headerRec} ${groupRec}`);
      } catch (e) { expect(['23514', '23503']).toContain((e as { code?: string }).code); }
      finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    }
    expect(await n(`SELECT count(*) n FROM invoice_vat_reviews WHERE company_id=$1`, [c2.id])).toBe(0);
    // self-approval is refused
    const own = await submitted(c2, [line('standard', '15')]);
    await expect(approve(c2, own, creator)).rejects.toMatchObject({ code: 'INVOICE_SELF_APPROVAL' });
  });

  it('posting: a tampered or wrong-direction VAT line is refused; equal-amount groups stay separate', async () => {
    const co = await company('posting');
    const inv = await submitted(co, [line('standard', '15', '100.00'), line('standard', '5', '300.00')]);
    const out = await approve(co, inv);
    const vatLines = await q(`SELECT id, debit::text d FROM journal_lines WHERE journal_entry_id=$1 AND memo='VAT_INPUT' ORDER BY sequence`, [out.journal_id]);
    expect(vatLines.map((l) => l.d)).toEqual(['15.00', '15.00']);
    await q(`UPDATE journal_lines SET memo='VAT_OUTPUT' WHERE id=$1`, [vatLines[0].id]);
    await expect(post(co, out.journal_id)).rejects.toThrow(/does not match the reviewed VAT snapshot|Invalid accounting relationship/);
    await q(`UPDATE journal_lines SET memo=NULL WHERE id=$1`, [vatLines[0].id]);
    await expect(post(co, out.journal_id)).rejects.toThrow(/does not match the reviewed VAT snapshot|Invalid accounting relationship/);
    expect((await q('SELECT status FROM journal_entries WHERE id=$1', [out.journal_id]))[0].status).toBe('draft');
    await q(`UPDATE journal_lines SET memo='VAT_INPUT' WHERE id=$1`, [vatLines[0].id]);
    await post(co, out.journal_id);
    expect((await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31')).invoices![0]!.reconciliation_status).toBe('reconciled');
    // forced past the service with an output-direction line: reconciliation reports wrong_vat_direction
    const c2 = await company('posting2');
    const inv2 = await submitted(c2, [line('standard', '15')]);
    const out2 = await approve(c2, inv2);
    await q(`UPDATE journal_lines SET memo='VAT_OUTPUT' WHERE journal_entry_id=$1 AND memo='VAT_INPUT'`, [out2.journal_id]);
    await q(`UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE id=$1`, [out2.journal_id, approver]);
    expect((await loadVatReconciliation(pool, c2.id, '2026-03-01', '2026-03-31')).invoices![0]!.reconciliation_status).toBe('wrong_vat_direction');
  });

  it('cross-period dates: VAT by tax point, monthly close by issue date; closed VAT period refuses approval atomically', async () => {
    const co = await company('period');
    await vatPeriod(co, '2026-04-01', '2026-06-30', 'closed');
    const blocked = await submitted(co, [line('standard', '15')], { issue: '2026-03-20', tax: '2026-05-02' });
    await expect(approve(co, blocked)).rejects.toMatchObject({ code: 'INVOICE_VAT_PERIOD_CLOSED' });
    for (const t of ['obligations', 'journal_entries', 'invoice_vat_reviews', 'invoice_number_counters']) expect(await n(`SELECT count(*) n FROM ${t} WHERE company_id=$1`, [co.id])).toBe(0);
    const ok = await submitted(co, [line('standard', '15')], { issue: '2026-03-28', tax: '2026-07-03' });
    const out = await approve(co, ok); await post(co, out.journal_id);
    expect((await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31')).invoices).toBeUndefined();
    expect((await loadVatReconciliation(pool, co.id, '2026-07-01', '2026-07-31')).invoices).toHaveLength(1);
    const { MonthlyCloseService } = await import('../src/modules/monthly-close/monthly-close.router');
    const mc = new MonthlyCloseService(pool);
    await q(`INSERT INTO monthly_close_periods (company_id, fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,'2026-03-01','2026-03-31','open')`, [co.id, co.fy]);
    expect(((await mc.list(co.id, ALL_VIEW)).periods[0]!.blockers as Record<string, number>).ledger).toBe(0);
  });

  it('monthly close: unposted or non-reconciling purchase VAT blocks the ledger; a clean posted purchase does not', async () => {
    const { MonthlyCloseService } = await import('../src/modules/monthly-close/monthly-close.router');
    const mc = new MonthlyCloseService(pool);
    const co = await company('mclose');
    await q(`INSERT INTO monthly_close_periods (company_id, fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,'2026-03-01','2026-03-31','open')`, [co.id, co.fy]);
    const blockers = async () => (await mc.list(co.id, ALL_VIEW)).periods[0]!.blockers as Record<string, number>;
    const inv = await submitted(co, [line('standard', '15'), line('zero_rated', '0')]);
    expect((await vat.readiness(co.id, '2026-03-01', '2026-03-31')).blockers.unapproved_documents).toBe(1); // submitted purchase
    const out = await approve(co, inv);
    expect((await blockers()).ledger).toBe(1);
    await post(co, out.journal_id);
    expect((await blockers()).ledger).toBe(0);
    const bad = await submitted(co, [line('standard', '15')], { issue: '2026-03-12' });
    const badOut = await approve(co, bad);
    await q(`UPDATE journal_lines SET memo=NULL WHERE journal_entry_id=$1 AND memo='VAT_INPUT'`, [badOut.journal_id]);
    await q(`UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE id=$1`, [badOut.journal_id, approver]);
    const broken = await blockers();
    expect(broken.ledger).toBe(1); expect(broken.vat).toBe(1);
  });

  it('duplicate prevention: documents, obligations and petty-cash allocations linked to a purchase invoice are never recognized twice', async () => {
    const co = await company('dup');
    const hist = await legacyDocument(co);
    const takeOver = await submitted(co, [line('standard', '15')], { doc: hist.id });
    await expect(approve(co, takeOver)).rejects.toMatchObject({ code: 'INVOICE_DOCUMENT_ALREADY_RECOGNIZED' });
    const fresh = await legacyDocument(co, { recognized: false, docDate: '2026-03-05' });
    const inv = await submitted(co, [line('standard', '15')], { doc: fresh.id });
    expect(await code(q(`INSERT INTO document_vat_reviews(company_id,document_id,tax_date,treatment,taxable_amount,vat_amount,review_status,reviewed_by_user_id,reviewed_at,recoverability_status,recoverable_vat_amount,recoverability_reviewed_by_user_id,recoverability_reviewed_at)
      VALUES($1,$2,'2026-03-05','standard',100,15,'reviewed',$3,NOW(),'fully_recoverable',15,$3,NOW())`, [co.id, fresh.id, creator]))).toBe('23514');
    expect(await code(q(`INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id)
      VALUES($1,'payable',$2,$3,115,'2026-03-05','confirmed','document',$4)`, [co.id, co.supp, fresh.id, creator]))).toBe('23514');
    await q('INSERT INTO memberships (user_id, company_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [creator, co.id]);
    const custody = (await q(`INSERT INTO custody_advances (company_id, holder_user_id, created_by_user_id) VALUES ($1,$2,$2) RETURNING id`, [co.id, creator]))[0].id;
    expect(await code(q(`INSERT INTO custody_document_allocations (company_id, custody_id, document_id, amount, created_by_user_id) VALUES ($1,$2,$3,10,$4)`, [co.id, custody, fresh.id, creator]))).toBe('23514');
    const out = await approve(co, inv); await post(co, out.journal_id);
    // one obligation per invoice
    expect(await code(q(`INSERT INTO obligations(company_id,direction,counterparty_id,invoice_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id)
      VALUES($1,'payable',$2,$3,115,'2026-03-10','confirmed','invoice',$4)`, [co.id, co.supp, inv.id, approver]))).not.toBe('ok');
    const rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.documents).toHaveLength(0);
    expect(rec.totals.reviewed_input_vat).toBe(15);
    expect((await vat.readiness(co.id, '2026-03-01', '2026-03-31')).blockers).toMatchObject({ missing_reviews: 0, vat_ledger_mismatches: 0 });
  });

  it('legacy purchase documents and approved return snapshots are unchanged by purchase invoices elsewhere', async () => {
    const legacy = await company('legacy'); const other = await company('legacy-other');
    await legacyDocument(legacy);
    const q1 = await vatPeriod(legacy, '2026-01-01', '2026-03-31');
    await vatPeriod(legacy, '2026-04-01', '2026-06-30');
    const snapshot = async () => JSON.stringify({ rec: await loadVatReconciliation(pool, legacy.id, '2026-01-01', '2026-03-31'), ready: await vat.readiness(legacy.id, '2026-01-01', '2026-03-31') });
    const before = await snapshot();
    await vat.close(legacy.id, approver, q1);
    const closedReport = JSON.stringify(await loadVatClosingReport(pool, legacy.id, q1));
    const { VatReturnService } = await import('../src/modules/vat/vat-returns.router');
    const returns = new VatReturnService(pool);
    const draft = await returns.create(legacy.id, approver, q1);
    const approved = await returns.approve(legacy.id, approver, draft.id, draft.version);
    expect(approved.snapshot_json).not.toHaveProperty('invoices');
    const later = await submitted(legacy, [line('standard', '15')], { issue: '2026-04-10' });
    const o1 = await approve(legacy, later); await post(legacy, o1.journal_id);
    const otherInv = await submitted(other, [line('standard', '15')], { issue: '2026-02-10' });
    const o2 = await approve(other, otherInv); await post(other, o2.journal_id);
    expect(await snapshot()).toBe(before);
    expect(JSON.stringify(await loadVatClosingReport(pool, legacy.id, q1))).toBe(closedReport);
    expect((await returns.get(legacy.id, draft.id)).snapshot_json).toEqual(approved.snapshot_json);
    // same period: documents unchanged, input totals = documents + invoice
    const mixedCo = await company('legacy-mixed');
    await legacyDocument(mixedCo);
    const docOnly = await loadVatReconciliation(pool, mixedCo.id, '2026-01-01', '2026-03-31');
    const same = await submitted(mixedCo, [line('standard', '15')], { issue: '2026-03-11' });
    const o3 = await approve(mixedCo, same); await post(mixedCo, o3.journal_id);
    const mixed = await loadVatReconciliation(pool, mixedCo.id, '2026-01-01', '2026-03-31');
    expect(mixed.documents).toEqual(docOnly.documents);
    expect(mixed.totals).toMatchObject({ reviewed_input_vat: 30, recoverable_input_vat: 30, ledger_input_vat: 30, input_difference: 0, reviewed_output_vat: docOnly.totals.reviewed_output_vat });
  });

  it('tenant isolation: another company neither sees nor affects purchase VAT', async () => {
    const a = await company('iso-a'); const b = await company('iso-b');
    const inv = await submitted(a, [line('standard', '15')]);
    const out = await approve(a, inv); await post(a, out.journal_id);
    expect((await loadVatReconciliation(pool, b.id, '2026-03-01', '2026-03-31')).invoices).toBeUndefined();
    await expect(approval.approve(b.id, approver, CAPS, inv.id, inv.version)).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    const unreviewed = await submitted(a, [line('standard', '15')]);
    expect(await code(q(`INSERT INTO invoice_vat_reviews (company_id, invoice_id, direction, tax_date, taxable_amount, vat_amount, reviewed_by_user_id, recoverable_vat_amount) VALUES ($1,$2,'purchase','2026-03-10',100,15,$3,15)`, [b.id, unreviewed.id, approver]))).toMatch(/^(23514|23503)$/);
    expect((await vat.readiness(b.id, '2026-03-01', '2026-03-31')).ready).toBe(true);
  });

  it('concurrency: purchase approvals racing VAT close never leave an unreconciled purchase in a closed period; parallel approvals number sequentially', async () => {
    const co = await company('race');
    for (const month of ['01', '02', '03']) {
      const period = await vatPeriod(co, `2026-${month}-01`, `2026-${month}-28`);
      const inv = await submitted(co, [line('standard', '15')], { issue: `2026-${month}-01`, tax: `2026-${month}-10` });
      const results = await Promise.allSettled([approve(co, inv), vat.close(co.id, approver, period)]);
      const closed = (await q('SELECT status FROM vat_periods WHERE id=$1', [period]))[0].status === 'closed';
      const approved = (await q('SELECT status FROM invoices WHERE id=$1', [inv.id]))[0].status === 'approved';
      expect(closed && approved).toBe(false);
      if (closed) expect(results[0].status).toBe('rejected');
    }
    const c2 = await company('race2');
    const invs = await Promise.all([1, 2, 3, 4].map(() => submitted(c2, [line('standard', '15')], { issue: '2026-05-10' })));
    const outs = await Promise.allSettled(invs.map((i) => approve(c2, i)));
    expect(outs.every((o) => o.status === 'fulfilled')).toBe(true);
    expect((await q(`SELECT internal_number::int n FROM invoices WHERE company_id=$1 AND direction='purchase' ORDER BY 1`, [c2.id])).map((r) => r.n)).toEqual([1, 2, 3, 4]);
    // the same invoice approved twice concurrently: exactly one wins, one review
    const once = await submitted(c2, [line('standard', '15')], { issue: '2026-05-11' });
    const twice = await Promise.allSettled([approve(c2, once), approve(c2, once)]);
    expect(twice.filter((t) => t.status === 'fulfilled')).toHaveLength(1);
    expect(await n('SELECT count(*) n FROM invoice_vat_reviews WHERE invoice_id=$1', [once.id])).toBe(1);
  });

  it('cancellation stays out of scope (V3): no cancel route or status write', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const services = ['invoice.service.ts', 'invoice-approval.service.ts', 'invoice.router.ts'].map((f) => readFileSync(join(__dirname, '../src/modules/invoices', f), 'utf8')).join('\n');
    expect(services).not.toMatch(/SET status\s*=\s*'cancelled'/i);
    expect(await n(`SELECT count(*) n FROM capabilities WHERE id='invoice.approve'`)).toBe(0);
  });
});
