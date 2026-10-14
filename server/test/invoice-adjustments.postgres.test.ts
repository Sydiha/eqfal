import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// F4 completion: externally issued credit / debit notes against approved invoices, over real PostgreSQL.
// Needs an isolated, disposable DATABASE_URL; skipped in CI like the other *.postgres.test.ts suites.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('external credit/debit notes (PostgreSQL)', () => {
  let pool: Pool;
  let drafts: import('../src/modules/invoices/invoice.service').InvoiceDraftService;
  let approval: import('../src/modules/invoices/invoice-approval.service').InvoiceApprovalService;
  let notes: import('../src/modules/invoices/invoice-adjustment.service').InvoiceAdjustmentService;
  let mappings: import('../src/modules/invoices/invoice-account-mapping.service').InvoiceAccountMappingService;
  let accounting: import('../src/modules/accounting/accounting.router').AccountingService;
  let parseDraft: typeof import('../src/modules/invoices/invoice.service').parseDraft;
  let parseAdjustment: typeof import('../src/modules/invoices/invoice-adjustment.service').parseAdjustment;
  let loadVatReconciliation: typeof import('../src/modules/vat/vat-reconciliation').loadVatReconciliation;
  const run = randomUUID().slice(0, 8);
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const n = async (sql: string, p: unknown[] = []) => Number((await q(sql, p))[0].n);
  const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
  let creator: string; let approver: string; let registrant: string;
  type Co = { id: string; fy: string; cust: string; supp: string; vatPeriod: string; acc: Record<string, string> };
  const CAPS = ['obligation.confirm', 'accounting.journal.create'];
  type L = { description: string; quantity: string; unit_price: string; vat_rate: string; vat_treatment: string; vat_recoverability?: string; vat_recoverable_percent?: unknown };
  const std = (recov?: string, percent?: unknown, price = '1000.00'): L => ({ description: 'std', quantity: '1', unit_price: price, vat_rate: '15', vat_treatment: 'standard',
    ...(recov ? { vat_recoverability: recov } : {}), ...(percent !== undefined ? { vat_recoverable_percent: percent } : {}) });
  type NL = { description?: string; vat_treatment: string; vat_rate: string; net_amount: string; vat_recoverability?: string; vat_recoverable_percent?: unknown };
  const nl = (net: string, extra: Partial<NL> = {}): NL => ({ description: 'note line', vat_treatment: 'standard', vat_rate: '15', net_amount: net, ...extra });
  let seq = 0;
  const noteBody = (type: 'credit' | 'debit', lines: NL[], extra: Record<string, unknown> = {}) =>
    ({ adjustment_type: type, external_number: `EXT-${run}-${++seq}`, adjustment_date: '2026-03-20', reason: 'External note', lines, ...extra });

  async function company(label: string, withVatInput = true, vatPeriod = true): Promise<Co> {
    const id = (await q('INSERT INTO companies (slug, name) VALUES ($1,$1) RETURNING id', [`ia-${label}-${run}`]))[0].id;
    const fy = (await q(`INSERT INTO fiscal_years (company_id, name, start_date, end_date) VALUES ($1,'FY','2026-01-01','2026-12-31') RETURNING id`, [id]))[0].id;
    const cust = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'C','customer',$2) RETURNING id`, [id, creator]))[0].id;
    const supp = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'S','supplier',$2) RETURNING id`, [id, creator]))[0].id;
    const vp = vatPeriod ? (await q(`INSERT INTO vat_periods (company_id, fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,'2026-03-01','2026-03-31','open') RETURNING id`, [id, fy]))[0].id : '';
    const co: Co = { id, fy, cust, supp, vatPeriod: vp, acc: {} };
    for (const [k, t] of Object.entries({ receivable: 'asset', payable: 'liability', sales_revenue: 'revenue', purchase_expense: 'expense', vat_output: 'liability', vat_input: 'asset' })) {
      co.acc[k] = (await q(`INSERT INTO accounts (company_id, code, name, account_type) VALUES ($1,$2,$2,$3) RETURNING id`, [id, `M-${k}`, t]))[0].id;
      if (k !== 'vat_input' || withVatInput) await mappings.set(id, approver, k, co.acc[k]);
    }
    return co;
  }
  /** An approved invoice whose journal is POSTED (the only kind a note can be registered against). */
  async function posted(co: Co, direction: 'sales' | 'purchase', lines: L[], opts: { post?: boolean; date?: string } = {}) {
    const date = opts.date ?? '2026-03-10';
    const inv = await drafts.create(co.id, creator, direction, parseDraft({ counterparty_id: direction === 'sales' ? co.cust : co.supp, issue_date: date, tax_point_date: date, lines }));
    const sub = await drafts.submit(co.id, creator, inv.id, inv.version);
    const out = await approval.approve(co.id, approver, CAPS, sub.id, sub.version);
    if (opts.post !== false) await accounting.post(co.id, approver, out.journal_id);
    return { id: sub.id as string, journal: out.journal_id as string, obligation: out.obligation_id as string };
  }
  const create = (co: Co, invoiceId: string, body: ReturnType<typeof noteBody>) => notes.create(co.id, registrant, invoiceId, parseAdjustment(body, 'create'));
  const approveNote = (co: Co, id: string, version: number, who = approver, caps = CAPS) => notes.approve(co.id, who, caps, id, version);
  const journal = async (id: string) => (await q(`SELECT a.account_type t, l.debit::text d, l.credit::text c, l.memo FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=$1 ORDER BY a.account_type, l.memo NULLS FIRST`, [id]));
  const snapshot = async (invoiceId: string) => ({
    invoice: (await q('SELECT * FROM invoices WHERE id=$1', [invoiceId]))[0],
    lines: await q('SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY line_number', [invoiceId]),
    obligation: (await q('SELECT * FROM obligations WHERE invoice_id=$1', [invoiceId]))[0],
    vat: await q('SELECT r.*, (SELECT json_agg(g ORDER BY g.vat_treatment, g.vat_rate) FROM invoice_vat_review_groups g WHERE g.review_id=r.id) groups FROM invoice_vat_reviews r WHERE r.invoice_id=$1', [invoiceId]),
    journal: await q(`SELECT j.status, l.* FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id JOIN obligations o ON o.id=j.source_id AND j.source_type='obligation' WHERE o.invoice_id=$1 ORDER BY l.sequence`, [invoiceId]),
    settlements: await q('SELECT s.* FROM obligation_settlements s JOIN obligations o ON o.id=s.obligation_id WHERE o.invoice_id=$1', [invoiceId]),
  });
  const updFrom = (b: Record<string, unknown>) => { const { adjustment_type: _t, ...rest } = b; return rest; };
  const updBody = (lines: NL[]) => updFrom(noteBody('credit', lines));
  let row = 0;
  const bankTx = async (co: Co, amount: string) => {
    row += 1;
    const account = (await q("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id", [co.id, creator]))[0].id;
    const batch = (await q("INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id", [co.id, account, randomUUID(), creator]))[0].id;
    return (await q("INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,description,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,'2026-03-25',$4,'SAR','tx',$5,$6,'strong') RETURNING id", [co.id, account, batch, amount, row, randomUUID()]))[0].id as string;
  };
  const settle = async (co: Co, obligation: string, amount: string) => q('INSERT INTO obligation_settlements(company_id,obligation_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,$4,$5)', [co.id, obligation, await bankTx(co, amount), amount, creator]);

  beforeAll(async () => {
    pool = (await import('../src/db/pool')).default!;
    const inv = await import('../src/modules/invoices/invoice.service');
    parseDraft = inv.parseDraft; drafts = new inv.InvoiceDraftService(pool);
    const adj = await import('../src/modules/invoices/invoice-adjustment.service');
    parseAdjustment = adj.parseAdjustment; notes = new adj.InvoiceAdjustmentService(pool);
    approval = new (await import('../src/modules/invoices/invoice-approval.service')).InvoiceApprovalService(pool);
    mappings = new (await import('../src/modules/invoices/invoice-account-mapping.service')).InvoiceAccountMappingService(pool);
    accounting = new (await import('../src/modules/accounting/accounting.router')).AccountingService(pool);
    loadVatReconciliation = (await import('../src/modules/vat/vat-reconciliation')).loadVatReconciliation;
    const user = async (l: string) => (await q(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [`ia-${l}-${run}@example.test`]))[0].id;
    creator = await user('c'); approver = await user('a'); registrant = await user('r');
  });
  afterAll(async () => { await pool?.end(); });

  it('registers invoice.adjust and invoice.adjust_approve as explicit-grant-only capabilities with no grants', async () => {
    expect(await n(`SELECT count(*) n FROM capabilities WHERE id IN ('invoice.adjust','invoice.adjust_approve') AND implicit_full_access = FALSE`)).toBe(2);
    expect(await n(`SELECT count(*) n FROM role_capabilities WHERE capability_id IN ('invoice.adjust','invoice.adjust_approve')`)).toBe(0);
  });

  it('sales credit note: own draft journal (mirror of the invoice), original untouched, adjusted outstanding, posts and reconciles, VAT report nets it', async () => {
    const co = await company('sc');
    const inv = await posted(co, 'sales', [std()]); // 1000 + 150 = 1150
    const before = await snapshot(inv.id);
    const draft = await create(co, inv.id, noteBody('credit', [nl('400.00')])); // 400 + 60 = 460
    expect(draft).toMatchObject({ status: 'draft', subtotal_amount: '400.00', vat_amount: '60.00', total_amount: '460.00', direction: 'sales' });
    expect(draft.lines).toHaveLength(1);
    // nothing is booked by a draft
    expect(await n(`SELECT count(*) n FROM journal_entries WHERE source_type='invoice_adjustment' AND source_id=$1`, [draft.id])).toBe(0);
    const out = await approveNote(co, draft.id, draft.version);
    expect(out.adjustment).toMatchObject({ status: 'approved', approved_by_user_id: approver });
    expect(await journal(out.journal_id)).toEqual([
      { t: 'asset', d: '0.00', c: '460.00', memo: null }, { t: 'liability', d: '60.00', c: '0.00', memo: 'VAT_OUTPUT' }, { t: 'revenue', d: '400.00', c: '0.00', memo: null }]);
    expect((await q('SELECT status FROM journal_entries WHERE id=$1', [out.journal_id]))[0].status).toBe('draft');
    // the original invoice, lines, obligation, journal, VAT snapshot and settlements are byte-for-byte unchanged
    expect(await snapshot(inv.id)).toEqual(before);
    // adjusted balances on the SAME obligation (no second receivable), read model and aging
    const read = await drafts.get(co.id, inv.id);
    expect(read).toMatchObject({ adjusted_amount: '690.00', adjustments_net_amount: '-460.00', outstanding_amount: '690.00', paid_amount: '0.00' });
    expect(read.adjustments).toHaveLength(1);
    expect(await n('SELECT count(*) n FROM obligations WHERE company_id=$1', [co.id])).toBe(1);
    const { ObligationAgingService } = await import('../src/modules/obligations/obligation-aging');
    const aging = await new ObligationAgingService(pool).report(co.id, '2026-03-31');
    expect(JSON.stringify(aging)).toContain('"outstanding_amount":"690.00"');
    // the note journal posts through the normal posting flow (its VAT line is verified against the approved note)
    // recognition timing: an approved note counts on the obligation/aging at approval (like an approved invoice), but its ledger side and the
    // VAT / month-close controls wait for the POSTED note journal: unposted => VAT readiness blocked
    const vatSvc = new (await import('../src/modules/vat/vat.router')).VatService(pool);
    expect((await vatSvc.readiness(co.id, '2026-03-01', '2026-03-31')).blockers.vat_ledger_mismatches).toBeGreaterThanOrEqual(1);
    expect((await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31')).invoice_adjustments![0]).toMatchObject({ reconciliation_status: 'missing_posted_journal', ledger_vat_amount: null });
    await accounting.post(co.id, approver, out.journal_id);
    expect((await vatSvc.readiness(co.id, '2026-03-01', '2026-03-31')).blockers.vat_ledger_mismatches).toBe(0);
    const rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.invoice_adjustments![0]).toMatchObject({ adjustment_type: 'credit', reconciliation_status: 'reconciled', vat_amount: '60.00', ledger_vat_amount: '60.00' });
    expect(rec.totals).toMatchObject({ reviewed_output_vat: 90, ledger_output_vat: 90, output_difference: 0 });
    expect(rec.counts).toEqual({ total_in_scope: 2, reconciled: 2, unreconciled: 0 });
    // closing report: credit REDUCES output VAT and the taxable base
    const vat = new (await import('../src/modules/vat/vat.router')).VatService(pool);
    await vat.close(co.id, approver, co.vatPeriod);
    const { loadVatClosingReport, buildVatWorkingPaperXlsx } = await import('../src/modules/vat/vat-report');
    const report = await loadVatClosingReport(pool, co.id, co.vatPeriod);
    expect(report.totals).toMatchObject({ output_vat: 90, sales_total: 690, net_vat: 90 });
    expect(report.treatments.standard).toMatchObject({ taxable_amount: 600, vat_amount: 90 });
    expect(report.invoice_adjustments).toHaveLength(1);
    expect(buildVatWorkingPaperXlsx(report).toString('latin1')).toContain('Credit note EXT-');
    // audit trail
    expect(await n(`SELECT count(*) n FROM audit_log WHERE entity_id=$1 AND action IN ('invoice.adjustment.create','invoice.adjustment.approve')`, [draft.id])).toBe(2);
  });

  it('sales debit note increases the receivable and output VAT on the same obligation', async () => {
    const co = await company('sd');
    const inv = await posted(co, 'sales', [std()]);
    const draft = await create(co, inv.id, noteBody('debit', [nl('100.00')])); // 115
    const out = await approveNote(co, draft.id, draft.version);
    expect(await journal(out.journal_id)).toEqual([
      { t: 'asset', d: '115.00', c: '0.00', memo: null }, { t: 'liability', d: '0.00', c: '15.00', memo: 'VAT_OUTPUT' }, { t: 'revenue', d: '0.00', c: '100.00', memo: null }]);
    expect(await drafts.get(co.id, inv.id)).toMatchObject({ adjusted_amount: '1265.00', outstanding_amount: '1265.00' });
    await accounting.post(co.id, approver, out.journal_id);
    const rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.totals).toMatchObject({ reviewed_output_vat: 165, ledger_output_vat: 165, output_difference: 0 });
  });

  it('purchase credit note keeps partial recoverability: expense gets the non-recoverable part, VAT_INPUT only the recoverable part', async () => {
    const co = await company('pc');
    const inv = await posted(co, 'purchase', [std('partially_recoverable', '40')]); // VAT 150: recoverable 60, non-recoverable 90
    const draft = await create(co, inv.id, noteBody('credit', [nl('500.00', { vat_recoverability: 'partially_recoverable', vat_recoverable_percent: '40' })])); // VAT 75: rec 30
    const out = await approveNote(co, draft.id, draft.version);
    expect(await journal(out.journal_id)).toEqual([
      { t: 'asset', d: '0.00', c: '30.00', memo: 'VAT_INPUT' }, { t: 'expense', d: '0.00', c: '545.00', memo: null }, { t: 'liability', d: '575.00', c: '0.00', memo: null }]);
    await accounting.post(co.id, approver, out.journal_id);
    const rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.totals).toMatchObject({ gross_reviewed_input_vat: 75, recoverable_input_vat: 30, non_recoverable_input_vat: 45, ledger_input_vat: 30, input_difference: 0 });
    expect(await drafts.get(co.id, inv.id)).toMatchObject({ adjusted_amount: '575.00', outstanding_amount: '575.00' });
    // recoverable VAT credited may never exceed what remains recoverable on the original (60 - 30 = 30)
    expect(await code(create(co, inv.id, noteBody('credit', [nl('500.00', { vat_recoverability: 'fully_recoverable' })])))).toBe('INVOICE_ADJUSTMENT_EXCEEDS_ORIGINAL');
  });

  it('non-recoverable purchase note needs no VAT input account and books the VAT inside the expense', async () => {
    const co = await company('pn', false);
    const inv = await posted(co, 'purchase', [std('non_recoverable')]); // expense 1150
    const draft = await create(co, inv.id, noteBody('credit', [nl('200.00', { vat_recoverability: 'non_recoverable' })])); // 230
    const out = await approveNote(co, draft.id, draft.version);
    expect(await journal(out.journal_id)).toEqual([
      { t: 'expense', d: '0.00', c: '230.00', memo: null }, { t: 'liability', d: '230.00', c: '0.00', memo: null }]);
    await accounting.post(co.id, approver, out.journal_id);
    const rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.invoice_adjustments![0]).toMatchObject({ reconciliation_status: 'reconciled', recoverable_vat_amount: '0.00' });
    expect(rec.totals).toMatchObject({ recoverable_input_vat: 0, ledger_input_vat: 0, input_difference: 0 });
  });

  it('purchase notes must state recoverability on every standard line; sales notes must not', async () => {
    const co = await company('rv');
    const pur = await posted(co, 'purchase', [std('fully_recoverable')]);
    const sal = await posted(co, 'sales', [std()]);
    expect(await code(create(co, pur.id, noteBody('credit', [nl('10.00')])))).toBe('INVOICE_VALIDATION');
    expect(await code(create(co, sal.id, noteBody('credit', [nl('10.00', { vat_recoverability: 'fully_recoverable' })])))).toBe('INVOICE_VALIDATION');
    expect(() => parseAdjustment(noteBody('credit', [nl('10.00', { vat_recoverability: 'partially_recoverable' })]), 'create')).toThrow(/vat_recoverable_percent is required/);
    expect(() => parseAdjustment(noteBody('credit', [nl('0.00')]), 'create')).toThrow(/greater than zero/);
    expect(() => parseAdjustment({ ...noteBody('credit', [nl('1.00')]), vat_amount: '1.00' }, 'create')).toThrow(/unknown fields/);
  });

  it('capabilities and versions: approval needs the accounting capabilities; the registrant holding them may approve', async () => {
    const co = await company('sep');
    const inv = await posted(co, 'sales', [std()]);
    const d = await create(co, inv.id, noteBody('credit', [nl('100.00')]));
    expect(await code(approveNote(co, d.id, d.version, registrant, ['obligation.confirm']))).toBe('INVOICE_FORBIDDEN');
    expect(await code(approveNote(co, d.id, d.version, approver, ['obligation.confirm']))).toBe('INVOICE_FORBIDDEN');
    expect(await code(approveNote(co, d.id, d.version + 4))).toBe('INVOICE_VERSION_CONFLICT');
    expect(await n(`SELECT count(*) n FROM journal_entries WHERE source_type='invoice_adjustment' AND source_id=$1`, [d.id])).toBe(0);
    // database-level separation too
    expect(await code(q(`UPDATE invoice_adjustments SET status='approved', approved_by_user_id=created_by_user_id, approved_at=NOW(), fiscal_year_id=$2 WHERE id=$1`, [d.id, co.fy]))).toBe('23514');
    const out = await approveNote(co, d.id, d.version);
    // approved notes are immutable: service and database
    expect(await code(approveNote(co, d.id, out.adjustment.version))).toBe('INVOICE_ADJUSTMENT_NOT_DRAFT');
    expect(await code(notes.cancel(co.id, registrant, d.id, out.adjustment.version, 'x'))).toBe('INVOICE_ADJUSTMENT_NOT_DRAFT');
    expect(await code(notes.update(co.id, registrant, d.id, out.adjustment.version, parseAdjustment(updBody([nl('1.00')]), 'update')))).toBe('INVOICE_ADJUSTMENT_NOT_DRAFT');
    expect(await code(q(`UPDATE invoice_adjustments SET reason='tamper' WHERE id=$1`, [d.id]))).toBe('23514');
    expect(await code(q(`DELETE FROM invoice_adjustments WHERE id=$1`, [d.id]))).toBe('23514');
    expect(await code(q(`UPDATE invoice_adjustment_lines SET net_amount=1 WHERE adjustment_id=$1`, [d.id]))).toBe('23514');
    // the note journal is protected like an invoice journal: lines cannot be altered or deleted
    expect(await code(q(`UPDATE journal_lines SET debit=1 WHERE journal_entry_id=$1 AND debit>0`, [out.journal_id]))).toBe('23514');
    expect(await code(q(`DELETE FROM journal_lines WHERE journal_entry_id=$1`, [out.journal_id]))).toBe('23514');
    expect(await code(q(`DELETE FROM journal_entries WHERE id=$1`, [out.journal_id]))).toBe('23514');
  });

  it('duplicate external numbers are refused per counterparty; a cancelled draft frees the number; edits keep the guarantee', async () => {
    const co = await company('dup');
    const a = await posted(co, 'sales', [std()]);
    const b = await posted(co, 'sales', [std()]);
    const body = noteBody('credit', [nl('10.00')]);
    const first = await create(co, a.id, body);
    expect(await code(create(co, a.id, body))).toBe('INVOICE_ADJUSTMENT_DUPLICATE');
    expect(await code(create(co, b.id, { ...body, external_number: body.external_number.toLowerCase() }))).toBe('INVOICE_ADJUSTMENT_DUPLICATE'); // same customer, other invoice, other case
    const other = await create(co, a.id, noteBody('credit', [nl('10.00')]));
    expect(await code(notes.update(co.id, registrant, other.id, other.version, parseAdjustment(updFrom(body), 'update')))).toBe('INVOICE_ADJUSTMENT_DUPLICATE');
    const cancelled = await notes.cancel(co.id, registrant, first.id, first.version, 'registered by mistake');
    expect(cancelled).toMatchObject({ status: 'cancelled', cancellation_reason: 'registered by mistake' });
    expect(await code(create(co, a.id, body))).toBe('ok');
  });

  it('credit caps: per VAT group against the original, cumulative across notes, no new treatment or rate, nothing for debit beyond existing groups', async () => {
    const co = await company('cap');
    const inv = await posted(co, 'sales', [std()]); // net 1000, VAT 150
    expect(await code(create(co, inv.id, noteBody('credit', [nl('1000.01')])))).toBe('INVOICE_ADJUSTMENT_EXCEEDS_ORIGINAL');
    const a = await create(co, inv.id, noteBody('credit', [nl('600.00')]));
    await approveNote(co, a.id, a.version);
    expect(await code(create(co, inv.id, noteBody('credit', [nl('400.01')])))).toBe('INVOICE_ADJUSTMENT_EXCEEDS_ORIGINAL');
    const b = await create(co, inv.id, noteBody('credit', [nl('400.00')]));
    expect(await code(approveNote(co, b.id, b.version))).toBe('ok');
    expect(await drafts.get(co.id, inv.id)).toMatchObject({ adjusted_amount: '0.00', outstanding_amount: '0.00', actionable_status: 'settled' });
    // a group that does not exist on the original invoice is unsupported (no rate / treatment is invented)
    expect(await code(create(co, inv.id, noteBody('debit', [nl('10.00', { vat_treatment: 'zero_rated', vat_rate: '0' })])))).toBe('INVOICE_ADJUSTMENT_GROUP_UNSUPPORTED');
    expect(await code(create(co, inv.id, noteBody('debit', [nl('10.00', { vat_rate: '5' })])))).toBe('INVOICE_ADJUSTMENT_GROUP_UNSUPPORTED');
  });

  it('settlement interplay: no credit beyond the outstanding balance (no credit balance / refund), and settlement can never exceed the adjusted amount', async () => {
    const co = await company('set');
    const inv = await posted(co, 'sales', [std()]);
    await settle(co, inv.obligation, '1000.00'); // outstanding 150
    expect(await code(create(co, inv.id, noteBody('credit', [nl('400.00')])))).toBe('INVOICE_ADJUSTMENT_EXCEEDS_OUTSTANDING');
    const fits = await create(co, inv.id, noteBody('credit', [nl('100.00')])); // 115 <= 150
    await approveNote(co, fits.id, fits.version);
    expect(await drafts.get(co.id, inv.id)).toMatchObject({ paid_amount: '1000.00', adjusted_amount: '1035.00', outstanding_amount: '35.00' });
    // a settlement above the adjusted outstanding (35.00) is refused by the database whatever the caller
    expect(await code(settle(co, inv.obligation, '35.01'))).toBe('23514');
    expect(await code(settle(co, inv.obligation, '35.00'))).toBe('ok');
    expect(await drafts.get(co.id, inv.id)).toMatchObject({ outstanding_amount: '0.00', actionable_status: 'settled' });
    // a fully paid invoice can no longer be credited (would be a refund)
    expect(await code(create(co, inv.id, noteBody('credit', [nl('1.00')])))).toBe('INVOICE_ADJUSTMENT_EXCEEDS_OUTSTANDING');
  });

  it('closed periods: accounting month, fiscal year and VAT period block registration/approval; ambiguous VAT-period treatment is refused', async () => {
    const co = await company('per');
    const inv = await posted(co, 'sales', [std()]);
    // accounting month closed -> refused at registration, nothing written
    await q(`INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-05-01','2026-05-31','closed')`, [co.id, co.fy]);
    await q(`INSERT INTO vat_periods (company_id, fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,'2026-05-01','2026-05-31','open')`, [co.id, co.fy]);
    // different VAT period than the original tax point: ambiguous -> refused
    expect(await code(create(co, inv.id, noteBody('credit', [nl('10.00')], { adjustment_date: '2026-05-10' })))).toBe('INVOICE_ADJUSTMENT_VAT_PERIOD_UNSUPPORTED');
    // no VAT period at all for the note date -> refused
    expect(await code(create(co, inv.id, noteBody('credit', [nl('10.00')], { adjustment_date: '2026-09-10' })))).toBe('INVOICE_ADJUSTMENT_VAT_PERIOD_UNSUPPORTED');
    // before the original invoice -> validation
    expect(await code(create(co, inv.id, noteBody('credit', [nl('10.00')], { adjustment_date: '2026-03-09' })))).toBe('INVOICE_VALIDATION');
    // closed accounting month of the note date (same VAT period as the invoice)
    const draft = await create(co, inv.id, noteBody('credit', [nl('10.00')]));
    await q(`INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-03-01','2026-03-31','closed')`, [co.id, co.fy]);
    expect(await code(approveNote(co, draft.id, draft.version))).toBe('INVOICE_PERIOD_CLOSED');
    expect(await code(create(co, inv.id, noteBody('credit', [nl('10.00')])))).toBe('INVOICE_PERIOD_CLOSED');
    await q(`UPDATE monthly_close_periods SET status='open' WHERE company_id=$1 AND period_start='2026-03-01'`, [co.id]);
    // closed VAT period (a filed return would need amending) -> refused at registration and at approval
    await q(`UPDATE vat_periods SET status='closed' WHERE id=$1`, [co.vatPeriod]);
    expect(await code(approveNote(co, draft.id, draft.version))).toBe('INVOICE_VAT_PERIOD_CLOSED');
    expect(await code(create(co, inv.id, noteBody('credit', [nl('10.00')])))).toBe('INVOICE_VAT_PERIOD_CLOSED');
    await q(`UPDATE vat_periods SET status='open' WHERE id=$1`, [co.vatPeriod]);
    // closed fiscal year -> approval refused
    await q(`UPDATE fiscal_years SET status='closed' WHERE id=$1`, [co.fy]).catch(() => undefined);
    const fyStatus = (await q('SELECT status FROM fiscal_years WHERE id=$1', [co.fy]))[0].status;
    if (fyStatus === 'closed') expect(['INVOICE_FISCAL_YEAR_CLOSED', 'INVOICE_PERIOD_CLOSED']).toContain(await code(approveNote(co, draft.id, draft.version)));
    expect(await n(`SELECT count(*) n FROM journal_entries WHERE source_type='invoice_adjustment' AND source_id=$1`, [draft.id])).toBe(0);
  });

  it('the original invoice must be approved with a POSTED journal; drafts, submitted and cancelled invoices are unsupported', async () => {
    const co = await company('orig');
    const unposted = await posted(co, 'sales', [std()], { post: false });
    expect(await code(create(co, unposted.id, noteBody('credit', [nl('10.00')])))).toBe('INVOICE_ADJUSTMENT_ORIGINAL_UNSUPPORTED');
    const draftInv = await drafts.create(co.id, creator, 'sales', parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', tax_point_date: '2026-03-10', lines: [std()] }));
    expect(await code(create(co, draftInv.id, noteBody('credit', [nl('10.00')])))).toBe('INVOICE_ADJUSTMENT_ORIGINAL_UNSUPPORTED');
    expect(await code(create(co, randomUUID(), noteBody('credit', [nl('10.00')])))).toBe('INVOICE_NOT_FOUND');
  });

  it('tenant isolation: another company can neither see, register against nor approve a note', async () => {
    const a = await company('ta');
    const b = await company('tb');
    const inv = await posted(a, 'sales', [std()]);
    const note = await create(a, inv.id, noteBody('credit', [nl('10.00')]));
    expect(await code(notes.create(b.id, registrant, inv.id, parseAdjustment(noteBody('credit', [nl('10.00')]), 'create')))).toBe('INVOICE_NOT_FOUND');
    expect(await code(notes.get(b.id, note.id))).toBe('INVOICE_ADJUSTMENT_NOT_FOUND');
    expect(await code(notes.approve(b.id, approver, CAPS, note.id, note.version))).toBe('INVOICE_ADJUSTMENT_NOT_FOUND');
    expect(await code(notes.cancel(b.id, registrant, note.id, note.version, 'x'))).toBe('INVOICE_ADJUSTMENT_NOT_FOUND');
    expect(await code(notes.listForInvoice(b.id, inv.id))).toBe('INVOICE_NOT_FOUND');
    expect((await notes.listForInvoice(a.id, inv.id)).adjustments).toHaveLength(1);
    // the database also refuses a note whose counterparty belongs to another company
    expect(await code(q(`INSERT INTO invoice_adjustments(company_id,original_invoice_id,direction,adjustment_type,adjustment_date,subtotal_amount,vat_amount,total_amount,reason,created_by_user_id,external_number,counterparty_id)
      VALUES($1,$2,'sales','credit','2026-03-20',1,0,1,'r',$3,'X-1',$4)`, [a.id, inv.id, registrant, b.cust]))).toBe('23503');
  });

  it('a note is posted only when its VAT lines match the approved note; supporting document is exclusive and not recognized twice', async () => {
    const co = await company('doc');
    const inv = await posted(co, 'sales', [std()]);
    const doc = (await q("INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256) VALUES($1,$2,'n.pdf','application/pdf',1,$3,$4) RETURNING id", [co.id, creator, randomUUID(), randomUUID().replace(/-/g, '').repeat(2)]))[0].id as string;
    const d = await create(co, inv.id, noteBody('credit', [nl('100.00')], { source_document_id: doc }));
    expect(d.source_document_id).toBe(doc);
    expect(await code(create(co, inv.id, noteBody('credit', [nl('1.00')], { source_document_id: doc })))).toBe('INVOICE_SOURCE_ALREADY_LINKED');
    const out = await approveNote(co, d.id, d.version);
    // after approval the document can no longer receive its own reviewed VAT (no duplicate recognition)
    expect(await code(q(`INSERT INTO document_vat_reviews(company_id,document_id,review_status,tax_date,treatment,taxable_amount,vat_amount) VALUES($1,$2,'reviewed','2026-03-20','standard',100,15)`, [co.id, doc]))).not.toBe('ok');
    await accounting.post(co.id, approver, out.journal_id);
    expect((await q('SELECT status FROM journal_entries WHERE id=$1', [out.journal_id]))[0].status).toBe('posted');
  });
});
