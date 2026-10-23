import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// V3.3: approved -> cancelled only while the note's own journal is a draft (journal becomes 'voided'), over real PostgreSQL.
// Needs an isolated, disposable DATABASE_URL; skipped in CI like the other *.postgres.test.ts suites.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('V3.3 cancel an approved credit/debit note while its journal is a draft (PostgreSQL)', () => {
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
  const CAPS = ['invoice.approve', 'invoice.adjust_approve'];
  const VOID = ['invoice.adjust_void'];
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
  /** An approved invoice (journal posted) plus one approved note whose journal is still a DRAFT. */
  async function setup(label: string, type: 'credit' | 'debit' = 'credit', net = '400.00', direction: 'sales' | 'purchase' = 'sales') {
    const co = await company(label);
    const inv = await posted(co, direction, [direction === 'purchase' ? std('fully_recoverable') : std()]);
    const draft = await create(co, inv.id, noteBody(type, [direction === 'purchase' ? nl(net, { vat_recoverability: 'fully_recoverable' }) : nl(net)]));
    const out = await approveNote(co, draft.id, draft.version);
    return { co, inv, note: out.adjustment as { id: string; version: number }, journal: out.journal_id as string };
  }
  const voidNote = (co: Co, id: string, version: number, reason = 'Registered by mistake', caps = VOID) => notes.voidApproved(co.id, approver, caps, id, version, reason);
  const noteRow = async (id: string) => (await q('SELECT * FROM invoice_adjustments WHERE id=$1', [id]))[0];
  const jrow = async (id: string) => (await q('SELECT * FROM journal_entries WHERE id=$1', [id]))[0];
  const jlines = async (id: string) => q('SELECT account_id, debit::text, credit::text, memo, sequence FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence', [id]);

  it('registers invoice.adjust_void: held by Full Access through the wildcard, granted to no role', async () => {
    expect(await n(`SELECT count(*) n FROM capabilities WHERE id = 'invoice.adjust_void' AND implicit_full_access = TRUE`)).toBe(1);
    expect(await n(`SELECT count(*) n FROM role_capabilities WHERE capability_id = 'invoice.adjust_void'`)).toBe(0);
  });

  it('cancels an approved note with a draft journal: numbers, lines, journal and original invoice preserved; balances and VAT restored', async () => {
    const { co, inv, note, journal: jid } = await setup('ok');
    const invoiceBefore = await snapshot(inv.id);
    const noteBefore = await noteRow(note.id);
    const linesBefore = await jlines(jid);
    expect(noteBefore.internal_number).not.toBeNull();
    expect(await drafts.get(co.id, inv.id)).toMatchObject({ outstanding_amount: '690.00' });
    const withNote = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(withNote.invoice_adjustments).toHaveLength(1);

    const after = await voidNote(co, note.id, note.version);
    expect(after).toMatchObject({ status: 'cancelled', cancellation_reason: 'Registered by mistake', cancelled_by_user_id: approver });
    const noteAfter = await noteRow(note.id);
    for (const k of ['internal_number', 'external_number', 'fiscal_year_id', 'approved_at', 'approved_by_user_id', 'subtotal_amount', 'vat_amount', 'total_amount', 'adjustment_date', 'adjustment_type', 'counterparty_id', 'original_invoice_id']) {
      expect(String(noteAfter[k])).toBe(String(noteBefore[k]));
    }
    expect(await n('SELECT count(*) n FROM invoice_adjustment_lines WHERE adjustment_id=$1', [note.id])).toBe(1);
    // journal kept (header + lines identical), only marked voided; never deleted
    const j = await jrow(jid);
    expect(j).toMatchObject({ status: 'voided', voided_by: approver, void_reason: 'Registered by mistake', posted_by: null, posted_at: null });
    expect(await jlines(jid)).toEqual(linesBefore);
    // the original invoice, obligation, VAT snapshot, journal and settlements are untouched
    expect(await snapshot(inv.id)).toEqual(invoiceBefore);
    // balances restored on the same obligation
    expect(await drafts.get(co.id, inv.id)).toMatchObject({ outstanding_amount: '1150.00', adjusted_amount: '1150.00' });
    // VAT reconciliation and report no longer see the note
    const recon = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(recon.invoice_adjustments ?? []).toHaveLength(0);
    expect(recon.totals.reviewed_output_vat).toBe(150);
    // not an operational source, no draft journal left to block monthly / annual close
    const { loadOperationalSources } = await import('../src/modules/accounting/operational-sources');
    expect((await loadOperationalSources(co.id, pool)).filter((s) => s.source_type === 'invoice_adjustment')).toHaveLength(0);
    expect(await n(`SELECT count(*) n FROM journal_entries WHERE company_id=$1 AND status='draft'`, [co.id])).toBe(0);
    // ledger / trial balance read posted journals only: the voided one contributes nothing
    expect(await n(`SELECT count(*) n FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.company_id=$1 AND j.status='posted' AND j.source_type='invoice_adjustment'`, [co.id])).toBe(0);
    // audit trail
    const audit = await q(`SELECT action, reason FROM audit_log WHERE company_id=$1 AND action IN ('invoice.adjustment.void','journal.void') ORDER BY action`, [co.id]);
    expect(audit).toEqual([{ action: 'invoice.adjustment.void', reason: 'Registered by mistake' }, { action: 'journal.void', reason: 'Registered by mistake' }]);
  });

  it('cancelled notes and voided journals can never be posted, reapproved, edited, deleted or reactivated (service and database)', async () => {
    const { co, note, journal: jid } = await setup('immut');
    await voidNote(co, note.id, note.version);
    expect(await code(accounting.post(co.id, approver, jid))).not.toBe('ok');
    expect(await code(q(`UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE id=$1`, [jid, approver]))).toBe('55000');
    expect(await code(q(`UPDATE journal_entries SET status='draft' WHERE id=$1`, [jid]))).toBe('55000');
    expect(await code(q(`UPDATE journal_entries SET description='x' WHERE id=$1`, [jid]))).toBe('55000');
    expect(await code(q(`DELETE FROM journal_entries WHERE id=$1`, [jid]))).toBe('23514'); // invoice journals are never deleted
    expect(await code(q(`UPDATE journal_lines SET memo='x' WHERE journal_entry_id=$1`, [jid]))).toBe('55000');
    expect(await code(q(`DELETE FROM journal_lines WHERE journal_entry_id=$1`, [jid]))).toBe('23514');
    expect(await code(q(`UPDATE invoice_adjustments SET status='approved' WHERE id=$1`, [note.id]))).toBe('23514');
    expect(await code(q(`UPDATE invoice_adjustments SET status='draft' WHERE id=$1`, [note.id]))).toBe('23514');
    expect(await code(q(`DELETE FROM invoice_adjustments WHERE id=$1`, [note.id]))).toBe('23514');
    expect(await code(notes.voidApproved(co.id, approver, VOID, note.id, note.version + 1, 'again'))).toBe('INVOICE_ADJUSTMENT_NOT_APPROVED');
    expect(await code(notes.cancel(co.id, approver, note.id, note.version + 1, 'again'))).toBe('INVOICE_ADJUSTMENT_NOT_DRAFT');
    expect(await jrow(jid)).toMatchObject({ status: 'voided' });
  });

  it('database: the transitions exist only through the controlled path', async () => {
    const { co, note, journal: jid } = await setup('ctl');
    // no controlled-path setting: neither the note nor its journal can be moved by raw SQL
    expect(await code(q(`UPDATE invoice_adjustments SET status='cancelled', cancelled_by_user_id=$2, cancelled_at=NOW(), cancellation_reason='x' WHERE id=$1`, [note.id, approver]))).toBe('23514');
    expect(await code(q(`UPDATE journal_entries SET status='voided', voided_at=NOW(), voided_by=$2, void_reason='x' WHERE id=$1`, [jid, approver]))).toBe('23514');
    // a journal can be voided only for a cancelled note, and a note cannot be cancelled without voiding its journal
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('eqfal.adjustment_void', $1, true)`, [note.id]);
      await c.query(`UPDATE invoice_adjustments SET status='cancelled', cancelled_by_user_id=$2, cancelled_at=NOW(), cancellation_reason='x' WHERE id=$1`, [note.id, approver]);
      await expect(c.query('COMMIT')).rejects.toMatchObject({ code: '23514' }); // deferred: the journal is still a draft
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    // the setting names ONE note: it never allows another note or any other journal
    const other = await setup('ctl2');
    const c2 = await pool.connect();
    try {
      await c2.query('BEGIN');
      await c2.query(`SELECT set_config('eqfal.adjustment_void', $1, true)`, [other.note.id]);
      await expect(c2.query(`UPDATE invoice_adjustments SET status='cancelled', cancelled_by_user_id=$2, cancelled_at=NOW(), cancellation_reason='x' WHERE id=$1`, [note.id, approver])).rejects.toMatchObject({ code: '23514' });
    } finally { await c2.query('ROLLBACK').catch(() => undefined); c2.release(); }
    // other fields cannot ride along with the cancellation
    const c3 = await pool.connect();
    try {
      await c3.query('BEGIN');
      await c3.query(`SELECT set_config('eqfal.adjustment_void', $1, true)`, [note.id]);
      await expect(c3.query(`UPDATE invoice_adjustments SET status='cancelled', cancelled_by_user_id=$2, cancelled_at=NOW(), cancellation_reason='x', reason='changed' WHERE id=$1`, [note.id, approver])).rejects.toMatchObject({ code: '23514' });
    } finally { await c3.query('ROLLBACK').catch(() => undefined); c3.release(); }
    // a manual journal can never become voided, and nothing can be inserted as voided
    const manual = (await q(`INSERT INTO journal_entries (company_id, fiscal_year_id, accounting_date, description, entry_type, status, created_by) VALUES ($1,$2,'2026-03-12','m','standard','draft',$3) RETURNING id`, [co.id, co.fy, approver]))[0].id;
    expect(await code(q(`UPDATE journal_entries SET status='voided', voided_at=NOW(), voided_by=$2, void_reason='x' WHERE id=$1`, [manual, approver]))).toBe('23514');
    expect(await code(q(`INSERT INTO journal_entries (company_id, fiscal_year_id, accounting_date, description, entry_type, status, source_type, source_id, voided_at, voided_by, void_reason, created_by) VALUES ($1,$2,'2026-03-12','m','standard','voided','invoice_adjustment',$3,NOW(),$4,'x',$4)`, [co.id, co.fy, randomUUID(), approver]))).toBe('23514');
    expect(await noteRow(note.id)).toMatchObject({ status: 'approved' });
    expect(await jrow(jid)).toMatchObject({ status: 'draft' });
  });

  it('refuses without the capability, without a reason path, on drafts, on posted journals, stale versions and other tenants', async () => {
    const { co, inv, note, journal: jid } = await setup('rej');
    expect(await code(voidNote(co, note.id, note.version, 'r', CAPS))).toBe('INVOICE_FORBIDDEN');
    expect(await code(voidNote(co, note.id, note.version + 5))).toBe('INVOICE_VERSION_CONFLICT');
    const draft = await create(co, inv.id, noteBody('credit', [nl('10.00')]));
    expect(await code(voidNote(co, draft.id, draft.version))).toBe('INVOICE_ADJUSTMENT_NOT_APPROVED');
    // tenant isolation: another company can neither see nor cancel it
    const foreign = await company('rej-other');
    expect(await code(notes.voidApproved(foreign.id, approver, VOID, note.id, note.version, 'x'))).toBe('INVOICE_ADJUSTMENT_NOT_FOUND');
    expect(await noteRow(note.id)).toMatchObject({ status: 'approved' });
    // posted journal: refused, nothing changes
    await accounting.post(co.id, approver, jid);
    expect(await code(voidNote(co, note.id, note.version))).toBe('INVOICE_ADJUSTMENT_JOURNAL_NOT_DRAFT');
    expect(await noteRow(note.id)).toMatchObject({ status: 'approved' });
    expect(await jrow(jid)).toMatchObject({ status: 'posted' });
  });

  it('closed accounting month, closed VAT period and a different VAT period block the cancellation', async () => {
    const { co, note, journal: jid } = await setup('per');
    await q(`INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-03-01','2026-03-31','closed')`, [co.id, co.fy]);
    expect(await code(voidNote(co, note.id, note.version))).toBe('INVOICE_PERIOD_CLOSED');
    await q(`UPDATE monthly_close_periods SET status='open' WHERE company_id=$1 AND period_start='2026-03-01'`, [co.id]);
    await q(`UPDATE vat_periods SET status='closed' WHERE id=$1`, [co.vatPeriod]);
    expect(await code(voidNote(co, note.id, note.version))).toBe('INVOICE_VAT_PERIOD_CLOSED');
    await q(`UPDATE vat_periods SET status='open' WHERE id=$1`, [co.vatPeriod]);
    // the VAT period of the original tax point disappearing / splitting is the same unsupported case as at approval
    await q(`UPDATE vat_periods SET period_end='2026-03-15' WHERE id=$1`, [co.vatPeriod]);
    await q(`INSERT INTO vat_periods (company_id, fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,'2026-03-16','2026-03-31','open')`, [co.id, co.fy]);
    expect(await code(voidNote(co, note.id, note.version))).toBe('INVOICE_ADJUSTMENT_VAT_PERIOD_UNSUPPORTED');
    expect(await noteRow(note.id)).toMatchObject({ status: 'approved' });
    expect(await jrow(jid)).toMatchObject({ status: 'draft' });
    await q(`UPDATE fiscal_years SET status='closed' WHERE id=$1`, [co.fy]).catch(() => undefined);
    if ((await q('SELECT status FROM fiscal_years WHERE id=$1', [co.fy]))[0].status === 'closed') {
      await q(`UPDATE vat_periods SET period_end='2026-03-31' WHERE id=$1`, [co.vatPeriod]).catch(() => undefined);
      expect(['INVOICE_FISCAL_YEAR_CLOSED', 'INVOICE_PERIOD_CLOSED', 'INVOICE_ADJUSTMENT_VAT_PERIOD_UNSUPPORTED']).toContain(await code(voidNote(co, note.id, note.version)));
    }
  });

  it('settlements: cancelling a debit note is refused when settlements would exceed the adjusted amount; a credit note that leaves room is fine', async () => {
    const dn = await setup('dn', 'debit', '200.00'); // invoice 1150 + debit 230 = 1380
    await settle(dn.co, dn.inv.obligation, '1300.00');
    expect(await code(voidNote(dn.co, dn.note.id, dn.note.version))).toBe('INVOICE_ADJUSTMENT_VOID_BLOCKED');
    expect(await noteRow(dn.note.id)).toMatchObject({ status: 'approved' });
    expect(await jrow(dn.journal)).toMatchObject({ status: 'draft' });
    // the database backstop refuses it too, whatever the caller does
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('eqfal.adjustment_void', $1, true)`, [dn.note.id]);
      await c.query(`UPDATE invoice_adjustments SET status='cancelled', cancelled_by_user_id=$2, cancelled_at=NOW(), cancellation_reason='x' WHERE id=$1`, [dn.note.id, approver]);
      await c.query(`UPDATE journal_entries SET status='voided', voided_at=NOW(), voided_by=$2, void_reason='x' WHERE id=$1`, [dn.journal, approver]);
      await expect(c.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    expect(await noteRow(dn.note.id)).toMatchObject({ status: 'approved' });
    // within the original amount a debit note can go
    await q('DELETE FROM obligation_settlements WHERE obligation_id=$1', [dn.inv.obligation]);
    await settle(dn.co, dn.inv.obligation, '1000.00');
    expect(await voidNote(dn.co, dn.note.id, dn.note.version)).toMatchObject({ status: 'cancelled' });
    expect(await drafts.get(dn.co.id, dn.inv.id)).toMatchObject({ paid_amount: '1000.00', outstanding_amount: '150.00' });
    // credit note: removing it only raises the adjusted amount, existing settlements stay valid
    const cn = await setup('cn', 'credit', '400.00'); // 1150 - 460 = 690
    await settle(cn.co, cn.inv.obligation, '600.00');
    expect(await voidNote(cn.co, cn.note.id, cn.note.version)).toMatchObject({ status: 'cancelled' });
    expect(await drafts.get(cn.co.id, cn.inv.id)).toMatchObject({ paid_amount: '600.00', outstanding_amount: '550.00' });
  });

  it('remaining credit limits: a debit note cannot be cancelled while approved credits rely on it', async () => {
    const co = await company('lim');
    const inv = await posted(co, 'sales', [std()]); // net 1000
    const dn = await create(co, inv.id, noteBody('debit', [nl('200.00')]));
    const dnOut = await approveNote(co, dn.id, dn.version);
    const cn = await create(co, inv.id, noteBody('credit', [nl('1100.00')])); // exceeds the original net 1000, allowed only because of the debit
    await approveNote(co, cn.id, cn.version);
    expect(await code(voidNote(co, dnOut.adjustment.id, dnOut.adjustment.version))).toBe('INVOICE_ADJUSTMENT_VOID_BLOCKED');
    expect(await noteRow(dn.id)).toMatchObject({ status: 'approved' });
  });

  it('purchase notes: cancels with recoverable VAT restored', async () => {
    const { co, inv, note } = await setup('pur', 'credit', '400.00', 'purchase');
    const before = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(before.invoice_adjustments).toHaveLength(1);
    await voidNote(co, note.id, note.version);
    const after = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(after.invoice_adjustments ?? []).toHaveLength(0);
    expect(after.totals.recoverable_input_vat).toBe(150);
    expect(await drafts.get(co.id, inv.id)).toMatchObject({ outstanding_amount: '1150.00' });
  });

  it('one atomic transaction: a failure after the updates rolls everything back', async () => {
    const { co, note, journal: jid } = await setup('rb');
    const { AuditLogRepository } = await import('../src/modules/audit-log/audit-log.repository');
    const spy = vi.spyOn(AuditLogRepository.prototype, 'logEvent');
    spy.mockImplementationOnce(async () => undefined as never).mockImplementationOnce(async () => { throw new Error('audit failure'); });
    await expect(voidNote(co, note.id, note.version)).rejects.toThrow('audit failure');
    spy.mockRestore();
    expect(await noteRow(note.id)).toMatchObject({ status: 'approved', cancelled_at: null });
    expect(await jrow(jid)).toMatchObject({ status: 'draft', voided_at: null });
    expect(await n(`SELECT count(*) n FROM audit_log WHERE company_id=$1 AND action IN ('invoice.adjustment.void','journal.void')`, [co.id])).toBe(0);
    // and it still works afterwards
    expect(await voidNote(co, note.id, note.version)).toMatchObject({ status: 'cancelled' });
  });

  it('concurrency: cancellation and posting of the note journal end in exactly one consistent state', async () => {
    for (let i = 0; i < 4; i++) {
      const { co, note, journal: jid } = await setup(`cc${i}`);
      const [a, b] = await Promise.all([code(voidNote(co, note.id, note.version)), code(accounting.post(co.id, approver, jid))]);
      const nr = await noteRow(note.id); const jr = await jrow(jid);
      if (nr.status === 'cancelled') { expect(jr.status).toBe('voided'); expect(a).toBe('ok'); expect(b).not.toBe('ok'); }
      else { expect(nr.status).toBe('approved'); expect(jr.status).toBe('posted'); expect(b).toBe('ok'); expect(a).not.toBe('ok'); }
    }
  });

  it('concurrency: two cancellations succeed once; cancellation and a settlement never leave settlements above the adjusted amount', async () => {
    const two = await setup('c2');
    const results = await Promise.all([code(voidNote(two.co, two.note.id, two.note.version)), code(voidNote(two.co, two.note.id, two.note.version))]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      const dn = await setup(`cs${i}`, 'debit', '200.00'); // adjusted 1380, original 1150
      const bank = await bankTx(dn.co, '1300.00');
      const settleRaw = q('INSERT INTO obligation_settlements(company_id,obligation_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,1300.00,$4)', [dn.co.id, dn.inv.obligation, bank, approver]);
      const [v, s] = await Promise.all([code(voidNote(dn.co, dn.note.id, dn.note.version)), code(settleRaw)]);
      const settled = await n('SELECT COALESCE(SUM(amount),0) n FROM obligation_settlements WHERE obligation_id=$1', [dn.inv.obligation]);
      const status = (await noteRow(dn.note.id)).status;
      // either the note was cancelled first (settlement above 1150 refused) or the settlement landed first (cancellation refused)
      expect(settled).toBeLessThanOrEqual(status === 'cancelled' ? 1150 : 1380);
      expect(v === 'ok' && s === 'ok').toBe(false);
      expect(status === 'cancelled' ? v : s).toBe('ok');
    }
  });
});

