import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Invoice VAT V2.1 (purchase input VAT recoverability) against real PostgreSQL. Needs an isolated, disposable DATABASE_URL; skipped in CI
// like the other *.postgres.test.ts suites. Owner policy 2026-10-12 (expense purchases only): non-recoverable input VAT is capitalized
// into the expense; partial recovery splits it (recoverable -> VAT_INPUT, rest -> expense). Recovery is explicit, never inferred.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('invoice VAT V2.1 purchase recoverability (PostgreSQL)', () => {
  let pool: Pool;
  let drafts: import('../src/modules/invoices/invoice.service').InvoiceDraftService;
  let approval: import('../src/modules/invoices/invoice-approval.service').InvoiceApprovalService;
  let mappings: import('../src/modules/invoices/invoice-account-mapping.service').InvoiceAccountMappingService;
  let accounting: import('../src/modules/accounting/accounting.router').AccountingService;
  let parseDraft: typeof import('../src/modules/invoices/invoice.service').parseDraft;
  let loadVatReconciliation: typeof import('../src/modules/vat/vat-reconciliation').loadVatReconciliation;
  const run = randomUUID().slice(0, 8);
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
  const n = async (sql: string, p: unknown[] = []) => Number((await q(sql, p))[0].n);
  const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
  let creator: string; let approver: string;
  type Co = { id: string; fy: string; cust: string; supp: string; acc: Record<string, string> };
  const CAPS = ['obligation.confirm', 'accounting.journal.create'];
  type L = { description: string; quantity: string; unit_price: string; vat_rate: string; vat_treatment: string; vat_recoverability?: string; vat_recoverable_percent?: unknown };
  const std = (recov?: string, percent?: unknown, price = '1000.00', rate = '15'): L => ({
    description: `std ${recov ?? 'none'}`, quantity: '1', unit_price: price, vat_rate: rate, vat_treatment: 'standard',
    ...(recov ? { vat_recoverability: recov } : {}), ...(percent !== undefined ? { vat_recoverable_percent: percent } : {}) });
  const zero = (): L => ({ description: 'zero', quantity: '1', unit_price: '50.00', vat_rate: '0', vat_treatment: 'zero_rated' });

  async function company(label: string, withVatInput = true): Promise<Co> {
    const id = (await q('INSERT INTO companies (slug, name) VALUES ($1,$1) RETURNING id', [`ivv21-${label}-${run}`]))[0].id;
    const fy = (await q(`INSERT INTO fiscal_years (company_id, name, start_date, end_date) VALUES ($1,'FY','2026-01-01','2026-12-31') RETURNING id`, [id]))[0].id;
    const cust = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'C','customer',$2) RETURNING id`, [id, creator]))[0].id;
    const supp = (await q(`INSERT INTO counterparties (company_id, name, type, created_by_user_id) VALUES ($1,'S','supplier',$2) RETURNING id`, [id, creator]))[0].id;
    const co: Co = { id, fy, cust, supp, acc: {} };
    for (const [k, t] of Object.entries({ receivable: 'asset', payable: 'liability', sales_revenue: 'revenue', purchase_expense: 'expense', vat_output: 'liability', vat_input: 'asset' })) {
      co.acc[k] = (await q(`INSERT INTO accounts (company_id, code, name, account_type) VALUES ($1,$2,$2,$3) RETURNING id`, [id, `M-${k}`, t]))[0].id;
      if (k !== 'vat_input' || withVatInput) await mappings.set(id, approver, k, co.acc[k]);
    }
    return co;
  }
  const body = (co: Co, lines: L[], extra: Record<string, unknown> = {}) =>
    ({ counterparty_id: co.supp, issue_date: '2026-03-10', tax_point_date: '2026-03-10', lines, ...extra });
  async function submitted(co: Co, lines: L[]) {
    const inv = await drafts.create(co.id, creator, 'purchase', parseDraft(body(co, lines)));
    const sub = await drafts.submit(co.id, creator, inv.id, inv.version);
    return { id: sub.id as string, version: sub.version as number };
  }
  const approve = (co: Co, inv: { id: string; version: number }) => approval.approve(co.id, approver, CAPS, inv.id, inv.version);
  const journal = async (id: string) => (await q(`SELECT a.account_type t, l.debit::text d, l.credit::text c, l.memo FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_entry_id=$1 ORDER BY l.sequence`, [id]));
  const balanced = async (id: string) => (await q('SELECT SUM(debit)=SUM(credit) ok FROM journal_lines WHERE journal_entry_id=$1', [id]))[0].ok as boolean;

  beforeAll(async () => {
    pool = (await import('../src/db/pool')).default!;
    const inv = await import('../src/modules/invoices/invoice.service');
    parseDraft = inv.parseDraft; drafts = new inv.InvoiceDraftService(pool);
    approval = new (await import('../src/modules/invoices/invoice-approval.service')).InvoiceApprovalService(pool);
    mappings = new (await import('../src/modules/invoices/invoice-account-mapping.service')).InvoiceAccountMappingService(pool);
    accounting = new (await import('../src/modules/accounting/accounting.router')).AccountingService(pool);
    loadVatReconciliation = (await import('../src/modules/vat/vat-reconciliation')).loadVatReconciliation;
    creator = (await q(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [`ivv21-c-${run}@example.test`]))[0].id;
    approver = (await q(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [`ivv21-a-${run}@example.test`]))[0].id;
  });
  afterAll(async () => { await pool?.end(); });

  it('fully recoverable: expense = net, VAT_INPUT = all VAT, payable = gross', async () => {
    const co = await company('full');
    const out = await approve(co, await submitted(co, [std('fully_recoverable')]));
    expect(await journal(out.journal_id)).toEqual([
      { t: 'expense', d: '1000.00', c: '0.00', memo: null }, { t: 'asset', d: '150.00', c: '0.00', memo: 'VAT_INPUT' }, { t: 'liability', d: '0.00', c: '1150.00', memo: null }]);
    expect(await balanced(out.journal_id)).toBe(true);
    expect((await q('SELECT recoverable_vat_amount::text r FROM invoice_vat_reviews WHERE invoice_id=$1', [out.invoice.id]))[0].r).toBe('150.00');
  });

  it('fully non-recoverable: VAT is capitalized into the expense, VAT_INPUT never touched, no vat_input mapping needed; posts and reconciles', async () => {
    const co = await company('non', false); // no VAT input account mapped at all
    const out = await approve(co, await submitted(co, [std('non_recoverable')]));
    expect(await journal(out.journal_id)).toEqual([
      { t: 'expense', d: '1150.00', c: '0.00', memo: null }, { t: 'liability', d: '0.00', c: '1150.00', memo: null }]);
    expect(await n(`SELECT count(*) n FROM journal_lines WHERE journal_entry_id=$1 AND (memo='VAT_INPUT' OR account_id=$2)`, [out.journal_id, co.acc.vat_input])).toBe(0);
    expect(await balanced(out.journal_id)).toBe(true);
    expect((await q('SELECT vat_amount::text v, recoverable_vat_amount::text r FROM invoice_vat_reviews WHERE invoice_id=$1', [out.invoice.id]))[0]).toEqual({ v: '150.00', r: '0.00' });
    await accounting.post(co.id, approver, out.journal_id);
    const rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.invoices![0]).toMatchObject({ reconciliation_status: 'reconciled', reviewed_vat_amount: '150.00', recoverable_vat_amount: '0.00' });
    expect(rec.totals).toMatchObject({ gross_reviewed_input_vat: 150, recoverable_input_vat: 0, non_recoverable_input_vat: 150, ledger_input_vat: 0 });
  });

  it('partially recoverable: split exactly, ROUND_HALF_UP per line, mixed recoveries inside one rate group, balanced, posts and reconciles', async () => {
    const co = await company('part');
    // 1000.00 @15% = 150.00 at 40%  -> 60.00 recoverable / 90.00 not
    // 1.00 @15% = 0.15 at 50%       -> 0.075 -> 0.08 recoverable / 0.07 not (half rounds up)
    // 200.00 @15% = 30.00 fully     -> 30.00 recoverable
    // 100.00 @15% = 15.00 non       -> 0 recoverable
    // 10.00 @5% = 0.50 at 33.33%    -> 0.166650 -> 0.17 recoverable / 0.33 not
    const out = await approve(co, await submitted(co, [
      std('partially_recoverable', '40'), std('partially_recoverable', '50.00', '1.00'), std('fully_recoverable', undefined, '200.00'),
      std('non_recoverable', undefined, '100.00'), std('partially_recoverable', '33.33', '10.00', '5'), zero()]));
    const groups = await q(`SELECT vat_rate::text r, vat_amount::text v, recoverable_vat_amount::text rv FROM invoice_vat_review_groups WHERE review_id=(SELECT id FROM invoice_vat_reviews WHERE invoice_id=$1) ORDER BY vat_treatment, vat_rate`, [out.invoice.id]);
    expect(groups).toEqual([{ r: '5.00', v: '0.50', rv: '0.17' }, { r: '15.00', v: '195.15', rv: '90.08' }, { r: '0.00', v: '0.00', rv: '0.00' }]);
    const lines = await journal(out.journal_id);
    // subtotal 1361.00 (incl. 50.00 zero-rated) + non-recoverable VAT (195.65 - 90.25 = 105.40) = 1466.40 expense; VAT_INPUT per rate group; payable = gross 1556.65
    expect(lines).toEqual([
      { t: 'expense', d: '1466.40', c: '0.00', memo: null }, { t: 'asset', d: '0.17', c: '0.00', memo: 'VAT_INPUT' },
      { t: 'asset', d: '90.08', c: '0.00', memo: 'VAT_INPUT' }, { t: 'liability', d: '0.00', c: '1556.65', memo: null }]);
    expect(await balanced(out.journal_id)).toBe(true);
    expect((await q('SELECT recoverable_vat_amount::text r, vat_amount::text v FROM invoice_vat_reviews WHERE invoice_id=$1', [out.invoice.id]))[0]).toEqual({ r: '90.25', v: '195.65' });
    await accounting.post(co.id, approver, out.journal_id);
    const rec = await loadVatReconciliation(pool, co.id, '2026-03-01', '2026-03-31');
    expect(rec.invoices![0]).toMatchObject({ reconciliation_status: 'reconciled', ledger_vat_amount: '90.25', recoverable_vat_amount: '90.25' });
    expect(rec.totals).toMatchObject({ gross_reviewed_input_vat: 195.65, recoverable_input_vat: 90.25, non_recoverable_input_vat: 105.4, ledger_input_vat: 90.25, input_difference: 0 });
    expect(await n(`SELECT count(*) n FROM journal_lines WHERE journal_entry_id=$1 AND memo='VAT_INPUT' AND credit<>0`, [out.journal_id])).toBe(0);
  });

  it('percent boundaries are validated and normalized; nothing is defaulted', async () => {
    const co = await company('bounds');
    const parse = (l: L) => () => parseDraft(body(co, [l]));
    for (const ok of ['0.01', '99.99', '50', '50.5', '0.5', '99']) expect(parse(std('partially_recoverable', ok)), ok).not.toThrow();
    const stored = parseDraft(body(co, [std('partially_recoverable', '50.5')])).lines[0]!;
    expect(stored.vat_recoverable_percent).toBe('50.50');
    for (const bad of ['0', '0.00', '100', '100.00', '100.01', '-1', '-0.01', '101', '50.123', 'abc', '', ' ', '1e1', '5,5', 50, null, undefined, {}]) {
      expect(parse(std('partially_recoverable', bad as never)), String(bad)).toThrow();
    }
    // percent only with partial; partial needs a percent; unknown statuses are rejected; non-standard lines carry none
    expect(parse(std('fully_recoverable', '50'))).toThrow(/only to partially_recoverable/);
    expect(parse(std('non_recoverable', '50'))).toThrow(/only to partially_recoverable/);
    expect(parse(std(undefined, '50'))).toThrow(/only to partially_recoverable/);
    expect(parse(std('partially_recoverable'))).toThrow(/required/);
    expect(parse(std('needs_review'))).toThrow(/not valid/);
    expect(parse({ ...zero(), vat_recoverability: 'non_recoverable' })).toThrow(/only to a standard line/);
    // sales lines never carry any recovery
    await expect(drafts.create(co.id, creator, 'sales', parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', tax_point_date: '2026-03-10', lines: [std('partially_recoverable', '50')] })))
      .rejects.toMatchObject({ code: 'INVOICE_VALIDATION' });
    // smallest and largest valid percent round exactly: 0.01% of 0.15 -> 0; 99.99% of 0.15 -> 0.15
    const tiny = await approve(co, await submitted(co, [std('partially_recoverable', '0.01', '1.00')]));
    expect((await q('SELECT recoverable_vat_amount::text r FROM invoice_vat_reviews WHERE invoice_id=$1', [tiny.invoice.id]))[0].r).toBe('0.00');
    expect((await journal(tiny.journal_id)).some((l) => l.memo === 'VAT_INPUT')).toBe(false);
    expect((await journal(tiny.journal_id))[0]).toMatchObject({ t: 'expense', d: '1.15' });
    const huge = await approve(co, await submitted(co, [std('partially_recoverable', '99.99', '1.00')]));
    expect((await q('SELECT recoverable_vat_amount::text r FROM invoice_vat_reviews WHERE invoice_id=$1', [huge.invoice.id]))[0].r).toBe('0.15');
  });

  it('a missing decision is never defaulted: submit and approval refuse, and nothing is written', async () => {
    const co = await company('missing');
    const draft = await drafts.create(co.id, creator, 'purchase', parseDraft(body(co, [std()])));
    await expect(drafts.submit(co.id, creator, draft.id, draft.version)).rejects.toMatchObject({ code: 'INVOICE_VAT_INCOMPLETE' });
    // behind the service's back: submitted without recovery, then with an incoherent partial statement forced past the table check
    await q(`UPDATE invoices SET status='submitted', version=version+1 WHERE id=$1`, [draft.id]);
    await expect(approve(co, { id: draft.id, version: draft.version + 1 })).rejects.toMatchObject({ code: 'INVOICE_VAT_INCOMPLETE' });
    expect(await n('SELECT count(*) n FROM obligations WHERE company_id=$1', [co.id])).toBe(0);
    expect(await n('SELECT count(*) n FROM invoice_vat_reviews WHERE company_id=$1', [co.id])).toBe(0);
    // the table itself refuses incoherent statements
    const id = draft.id;
    expect(await code(q(`UPDATE invoice_lines SET vat_recoverability='partially_recoverable' WHERE invoice_id=$1`, [id]))).toBe('23514');
    for (const p of ['0', '100', '-5', '150']) {
      expect(await code(q(`UPDATE invoice_lines SET vat_recoverability='partially_recoverable', vat_recoverable_percent=$2 WHERE invoice_id=$1`, [id, p])), p).toBe('23514');
    }
    expect(await code(q(`UPDATE invoice_lines SET vat_recoverability='non_recoverable', vat_recoverable_percent=50 WHERE invoice_id=$1`, [id]))).toBe('23514');
    expect(await code(q(`UPDATE invoice_lines SET vat_recoverability='fully_recoverable', vat_recoverable_percent=50 WHERE invoice_id=$1`, [id]))).toBe('23514');
    expect(await code(q(`UPDATE invoice_lines SET vat_recoverability='bogus' WHERE invoice_id=$1`, [id]))).toBe('23514');
  });

  it('snapshot and posting are exact: a tampered VAT_INPUT amount (or a non-recoverable invoice given a VAT_INPUT line) cannot post', async () => {
    const co = await company('tamper');
    const part = await approve(co, await submitted(co, [std('partially_recoverable', '40')]));
    // journal line amounts are immutable in the database; the only writable field is the memo, so the tamper is a moved/removed VAT stamp
    await q(`UPDATE journal_lines SET memo=NULL WHERE journal_entry_id=$1 AND memo='VAT_INPUT'`, [part.journal_id]);
    await expect(accounting.post(co.id, approver, part.journal_id)).rejects.toThrow(/VAT recognition does not match/);
    const non = await approve(co, await submitted(co, [std('non_recoverable')]));
    await q(`UPDATE journal_lines SET memo='VAT_INPUT' WHERE journal_entry_id=$1 AND debit>0`, [non.journal_id]);
    await expect(accounting.post(co.id, approver, non.journal_id)).rejects.toThrow(/VAT recognition does not match/);
    // the immutable snapshot cannot be rewritten
    expect(await code(q(`UPDATE invoice_vat_review_groups SET recoverable_vat_amount=150 WHERE review_id=(SELECT id FROM invoice_vat_reviews WHERE invoice_id=$1)`, [non.invoice.id]))).not.toBe('ok');
  });

  it('monthly close: a posted partial and a posted non-recoverable purchase are clean; a tampered one blocks', async () => {
    const { MonthlyCloseService } = await import('../src/modules/monthly-close/monthly-close.router');
    const mc = new MonthlyCloseService(pool);
    const co = await company('mclose');
    await q(`INSERT INTO monthly_close_periods (company_id, fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,'2026-03-01','2026-03-31','open')`, [co.id, co.fy]);
    const view = ['document.view', 'obligation.view', 'bank.view', 'vat.view', 'accounting.view', 'asset.view', 'opening_balance.view', 'periodic_adjustment.view'];
    const blockers = async () => (await mc.list(co.id, view)).periods[0]!.blockers as Record<string, number>;
    for (const l of [std('partially_recoverable', '40'), std('non_recoverable')]) await accounting.post(co.id, approver, (await approve(co, await submitted(co, [l]))).journal_id);
    expect((await blockers()).ledger).toBe(0);
    const bad = await approve(co, await submitted(co, [std('partially_recoverable', '40')]));
    await q(`UPDATE journal_lines SET memo=NULL WHERE journal_entry_id=$1 AND memo='VAT_INPUT'`, [bad.journal_id]);
    await q(`UPDATE journal_entries SET status='posted', posted_by=$2, posted_at=NOW() WHERE id=$1`, [bad.journal_id, approver]);
    expect((await blockers()).ledger).toBe(1);
  });

  it('tenant isolation: another company cannot read, approve or affect the recovery data', async () => {
    const a = await company('ta'); const b = await company('tb');
    const inv = await submitted(a, [std('partially_recoverable', '40')]);
    await expect(drafts.get(b.id, inv.id)).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    await expect(approval.approve(b.id, approver, CAPS, inv.id, inv.version)).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    const own = await drafts.get(a.id, inv.id);
    expect(own!.lines[0]).toMatchObject({ vat_recoverability: 'partially_recoverable', vat_recoverable_percent: '40.00' });
    expect(await n('SELECT count(*) n FROM invoice_lines WHERE company_id=$1', [b.id])).toBe(0);
  });

  it('closing report and XLSX: classification comes from the amounts, and net VAT uses RECOVERABLE input VAT only', async () => {
    const co = await company('report');
    const period = (await q(`INSERT INTO vat_periods (company_id, fiscal_year_id, period_start, period_end, status) VALUES ($1,$2,'2026-03-01','2026-03-31','open') RETURNING id`, [co.id, co.fy]))[0].id as string;
    const vat = new (await import('../src/modules/vat/vat.router')).VatService(pool);
    const sale = await drafts.create(co.id, creator, 'sales', parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', tax_point_date: '2026-03-10',
      lines: [{ description: 's', quantity: '1', unit_price: '1000.00', vat_rate: '15', vat_treatment: 'standard' }] }));
    const saleSub = await drafts.submit(co.id, creator, sale.id, sale.version);
    const invoices = [
      { id: saleSub.id as string, version: saleSub.version as number },
      await submitted(co, [std('fully_recoverable', undefined, '200.00')]), // VAT 30.00, recoverable 30.00
      await submitted(co, [std('partially_recoverable', '40')]), // VAT 150.00, recoverable 60.00
      await submitted(co, [std('non_recoverable', undefined, '100.00')]), // VAT 15.00, recoverable 0
      await submitted(co, [std('fully_recoverable', undefined, '200.00'), std('non_recoverable', undefined, '100.00')]), // one 15% group: VAT 45.00, recoverable 30.00
    ];
    for (const inv of invoices) await accounting.post(co.id, approver, (await approve(co, inv)).journal_id);
    await vat.close(co.id, approver, period);
    const { loadVatClosingReport, buildVatWorkingPaperXlsx, netVatOf, recoverabilityOf } = await import('../src/modules/vat/vat-report');
    const report = await loadVatClosingReport(pool, co.id, period);
    // gross input 30+150+15+45 = 240; recoverable 30+60+0+30 = 120; non-recoverable 120; output 150
    expect(report.totals).toMatchObject({ output_vat: 150, input_vat: 240, gross_reviewed_input_vat: 240, recoverable_input_vat: 120, non_recoverable_input_vat: 120,
      net_vat: 30, base_net_vat: 30, fully_recoverable_documents: 1, partially_recoverable_documents: 2, non_recoverable_documents: 1 });
    expect(netVatOf(report.totals)).toBe(30); // never output - gross input (which would be -90)
    const text = buildVatWorkingPaperXlsx(report).toString('latin1');
    const count = (label: string) => (text.match(new RegExp(`>${label}<`, 'g')) ?? []).length;
    expect({ fully: count('fully_recoverable'), partial: count('partially_recoverable'), non: count('non_recoverable') }).toEqual({ fully: 1, partial: 2, non: 1 });
    expect(text).toContain('Net VAT (Output');
    // pure classification from amounts, including the ends and a zero-VAT group
    expect(recoverabilityOf('150.00', '150.00')).toBe('fully_recoverable');
    expect(recoverabilityOf('150.00', '0.00')).toBe('non_recoverable');
    expect(recoverabilityOf('150.00', null)).toBe('non_recoverable');
    expect(recoverabilityOf('45.00', '30.00')).toBe('partially_recoverable');
    expect(recoverabilityOf('0.00', '0.00')).toBe('not_applicable');
    // the approved return snapshot carries the corrected base net VAT
    const { VatReturnService } = await import('../src/modules/vat/vat-returns.router');
    const returns = new VatReturnService(pool);
    const draft = await returns.create(co.id, approver, period);
    const approved = await returns.approve(co.id, approver, draft.id, draft.version);
    expect((approved.snapshot_json as { totals: { net_vat: number } }).totals.net_vat).toBe(30);
  });

  it('sales VAT V1 is unchanged, and invoice approval stays disabled (no route, no capability)', async () => {
    const co = await company('sales');
    const draft = await drafts.create(co.id, creator, 'sales', parseDraft({ counterparty_id: co.cust, issue_date: '2026-03-10', tax_point_date: '2026-03-10',
      lines: [{ description: 's', quantity: '1', unit_price: '1000.00', vat_rate: '15', vat_treatment: 'standard' }] }));
    const sub = await drafts.submit(co.id, creator, draft.id, draft.version);
    const out = await approve(co, { id: sub.id, version: sub.version });
    expect(await journal(out.journal_id)).toEqual([
      { t: 'asset', d: '1150.00', c: '0.00', memo: null }, { t: 'revenue', d: '0.00', c: '1000.00', memo: null }, { t: 'liability', d: '0.00', c: '150.00', memo: 'VAT_OUTPUT' }]);
    expect((await q('SELECT recoverable_vat_amount r FROM invoice_vat_reviews WHERE invoice_id=$1', [out.invoice.id]))[0].r).toBeNull();
    // F1: registered (migration 070) but explicit-grant-only and never auto-granted to Full Access.
    expect(await n(`SELECT count(*) n FROM capabilities WHERE id='invoice.approve' AND implicit_full_access = FALSE`)).toBe(1);
    expect(await n(`SELECT count(*) n FROM role_capabilities WHERE capability_id='invoice.approve' AND role_id IN (SELECT id FROM roles WHERE is_full_access)`)).toBe(0);
    const { readFileSync, readdirSync } = await import('fs');
    const { join } = await import('path');
    const src = join(__dirname, '../src');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const callers = walk(src).filter((f) => f.endsWith('.ts') && !f.endsWith('invoice-approval.service.ts') && /InvoiceApprovalService/.test(readFileSync(f, 'utf8')));
    // F1: the approval service is reached only through the invoice router's guarded approve route.
    expect(callers.map((f) => f.split('/').pop())).toEqual(['invoice.router.ts']);
  });
});
