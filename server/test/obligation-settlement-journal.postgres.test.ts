import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { UNRESOLVED_BANK_TRANSACTION_SQL } from '../src/modules/banking/bank-reconciliation-core';

// Prefilled settlement journals for invoice obligations (supplier payment, customer receipt, government payment) over real HTTP + PostgreSQL.
// Requires a disposable DATABASE_URL. The journal is only ever a DRAFT; posting is explicit and re-verified by the database-backed contract.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('obligation settlement journal prefill and posting contract (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;
  let approval: import('../src/modules/invoices/invoice-approval.service').InvoiceApprovalService;
  beforeAll(async () => {
    h = await startHarness();
    const { InvoiceApprovalService } = await import('../src/modules/invoices/invoice-approval.service');
    approval = new InvoiceApprovalService(h.db);
  });
  afterAll(() => h.close());
  let rowNo = 0;

  async function setup(label: string, opts: { link?: boolean } = {}) {
    const owner = await h.user(`${label}-own`);
    const id = await h.company(label, owner.id);
    await owner.client.login();
    const fy = await h.fiscalYear(id, 'FY26', '2026-01-01', '2026-12-31');
    await h.db.query(
      `INSERT INTO company_accounting_profiles(company_id,version_no,workflow_status,accounting_framework,functional_currency,reporting_currency,first_live_accounting_date,vat_status,tax_treatment,ownership_context,wht_profile,has_non_resident_dealings,effective_from,prepared_by_user_id,approved_by_user_id,approved_at)
       VALUES($1,1,'approved','IFRS','SAR','SAR','2025-01-01','not_registered','zakat_applicable','saudi_gcc_only','not_currently_applicable','no','2025-01-01',$2,$2,NOW())`, [id, owner.id]);
    const acc: Record<string, string> = {};
    for (const [k, t, cat] of [['receivable', 'asset', 'current_asset'], ['payable', 'liability', 'current_liability'], ['sales_revenue', 'revenue', 'unmapped'],
      ['purchase_expense', 'expense', 'unmapped'], ['vat_output', 'liability', 'current_liability'], ['vat_input', 'asset', 'current_asset']] as const) {
      acc[k] = await h.account(id, `M-${k}`, t, cat);
      await h.q('INSERT INTO invoice_account_mappings(company_id,mapping_key,account_id,updated_by_user_id) VALUES($1,$2,$3,$4)', [id, k, acc[k], owner.id]);
    }
    acc['bankGl'] = await h.account(id, 'B-BANK', 'asset', 'current_asset');
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1", [acc['bankGl']]);
    acc['other'] = await h.account(id, 'OTHER', 'asset', 'current_asset');
    const bank = (await h.q<{ id: string }>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id", [id, owner.id]))[0]!.id;
    const batch = (await h.q<{ id: string }>(
      "INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,'s.csv','text/csv','csv',$3,$3,'confirmed',$4) RETURNING id",
      [id, bank, `k-${randomUUID()}`, owner.id]))[0]!.id;
    if (opts.link !== false) {
      const r = await owner.client.req('POST', '/bank-ledger-links', { bank_account_id: bank, account_id: acc['bankGl'], valid_from: '2026-01-01' });
      expect(r.status).toBe(201);
    }
    const cp = async (name: string, type: string) => (await h.q<{ id: string }>('INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,$2,$3,$4) RETURNING id', [id, name, type, owner.id]))[0]!.id;
    return { id, owner, fy, acc, bank, batch, supplier: await cp('Supplier', 'supplier'), customer: await cp('Customer', 'customer'), government: await cp('GOSI', 'government') };
  }
  type Co = Awaited<ReturnType<typeof setup>>;

  /** An approved invoice with its recognition journal POSTED, exactly as the application creates it. Purchase 20 + 3 VAT; sales 100 + 15 VAT. */
  async function invoice(co: Co, direction: 'purchase' | 'sales', counterparty?: string) {
    const vat = direction === 'purchase' ? 3 : 15, net = direction === 'purchase' ? 20 : 100;
    const invoiceId = (await h.q<{ id: string }>(
      `INSERT INTO invoices(company_id,direction,counterparty_id,issue_date,subtotal_amount,vat_amount,total_amount,created_by_user_id) VALUES($1,$2,$3,'2026-03-10',$4::numeric,$5::numeric,$4::numeric+$5::numeric,$6) RETURNING id`,
      [co.id, direction, counterparty ?? (direction === 'purchase' ? co.supplier : co.customer), net, vat, co.owner.id]))[0]!.id;
    await h.q(`INSERT INTO invoice_lines(company_id,invoice_id,line_number,description,quantity,unit_price,vat_rate,net_amount,vat_amount,total_amount,vat_treatment,vat_recoverability)
               VALUES($1,$2,1,'Line',1,$3::numeric,15,$3::numeric,$4::numeric,$3::numeric+$4::numeric,'standard',$5)`, [co.id, invoiceId, net, vat, direction === 'purchase' ? 'fully_recoverable' : null]);
    await h.q("UPDATE invoices SET tax_point_date=issue_date, status='submitted', version=version+1 WHERE id=$1", [invoiceId]);
    const version = (await h.q<{ version: number }>('SELECT version FROM invoices WHERE id=$1', [invoiceId]))[0]!.version;
    const out = await approval.approve(co.id, co.owner.id, ['invoice.approve'], invoiceId, version);
    // Approval is by a different person in production; the fixture owner is acceptable here because the service is called directly.
    const posted = await co.owner.client.req('POST', `/journals/${out.journal_id}/post`, {});
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    return { invoiceId, obligationId: out.obligation_id, journalId: out.journal_id, total: String(net + vat) };
  }
  async function bankTx(co: Co, date: string, amount: string) {
    rowNo += 1;
    return (await h.q<{ id: string }>(
      "INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,$4,$5,'SAR',$6,$7,'strong') RETURNING id",
      [co.id, co.bank, co.batch, date, amount, rowNo, `fp-${randomUUID()}`]))[0]!.id;
  }
  async function settle(co: Co, obligationId: string, tx: string, amount: string) {
    const r = await co.owner.client.req('POST', `/obligations/${obligationId}/settlements`, { bank_transaction_id: tx, amount });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.id as string;
  }
  const prefill = (co: Co, settlementId: string) => co.owner.client.req('POST', `/accounting/obligation-settlements/${settlementId}/journal`, {});
  const post = (co: Co, journal: string) => co.owner.client.req('POST', `/journals/${journal}/post`, {});
  const net = async (co: Co, account: string) =>
    (await h.q<{ n: string }>("SELECT COALESCE(SUM(l.debit-l.credit),0)::text n FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.company_id=$1 AND j.status='posted' AND l.account_id=$2", [co.id, account]))[0]!.n;
  const lines = (journalId: string) => h.q<{ account_id: string; debit: string; credit: string }>('SELECT account_id,debit::text,credit::text FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence', [journalId]);

  it('supplier payment of SAR 23 (20 + 3 VAT): prefilled draft, explicit posting, invoice lines untouched, ledger and reconciliation consistent', async () => {
    const co = await setup('sup');
    const inv = await invoice(co, 'purchase');
    const tx = await bankTx(co, '2026-03-20', '-23.00');
    const s = await settle(co, inv.obligationId, tx, '23.00');

    // before any journal: the obligation list warns that the settlement journal is pending
    const before = (await co.owner.client.req('GET', '/obligations')).json.obligations.find((o: { id: string }) => o.id === inv.obligationId);
    expect(before).toMatchObject({ state: 'settled', pending_settlement_journals: 1 });
    expect(await net(co, co.acc['payable']!)).toBe('-23.00');

    const r = await prefill(co, s);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({ status: 'draft', source_type: 'obligation_settlement', source_id: s, accounting_date: '2026-03-20' });
    expect(await lines(r.json.id)).toEqual([
      { account_id: co.acc['payable'], debit: '23.00', credit: '0.00' },
      { account_id: co.acc['bankGl'], debit: '0.00', credit: '23.00' }]);
    expect(await net(co, co.acc['payable']!)).toBe('-23.00'); // nothing is posted automatically
    expect((await co.owner.client.req('GET', '/obligations')).json.obligations.find((o: { id: string }) => o.id === inv.obligationId).pending_settlement_journals).toBe(1);

    expect((await post(co, r.json.id)).status).toBe(200);
    expect(await net(co, co.acc['payable']!)).toBe('0.00');
    expect(await net(co, co.acc['bankGl']!)).toBe('-23.00');
    // the invoice's own expense and input VAT are recognised once, by the invoice journal only
    expect(await net(co, co.acc['purchase_expense']!)).toBe('20.00');
    expect(await net(co, co.acc['vat_input']!)).toBe('3.00');
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.source_id=$1", [s])).toBe(2);
    expect((await co.owner.client.req('GET', '/obligations')).json.obligations.find((o: { id: string }) => o.id === inv.obligationId).pending_settlement_journals).toBe(0);
    // trial balance stays balanced
    const tb = (await h.q<{ d: string; c: string }>("SELECT SUM(l.debit)::text d, SUM(l.credit)::text c FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.company_id=$1 AND j.status='posted'", [co.id]))[0]!;
    expect(tb.d).toBe(tb.c);
    // the bank row stays explained for closing, and its amount is frozen once the settlement journal is posted
    expect(await h.count(`SELECT COUNT(*)::text n FROM bank_transactions t WHERE t.company_id=$1 AND t.id=$2 AND ${UNRESOLVED_BANK_TRANSACTION_SQL}`, [co.id, tx])).toBe(0);
    await expect(h.q('UPDATE bank_transactions SET amount=-24 WHERE id=$1', [tx])).rejects.toThrow(/immutable/i);
  });

  it('customer receipt debits the bank and credits the receivable; government payment of a government payable uses the payable', async () => {
    const co = await setup('cus');
    const sale = await invoice(co, 'sales');
    const s1 = await settle(co, sale.obligationId, await bankTx(co, '2026-03-21', '115.00'), '115.00');
    const j1 = await prefill(co, s1);
    expect(await lines(j1.json.id)).toEqual([
      { account_id: co.acc['bankGl'], debit: '115.00', credit: '0.00' },
      { account_id: co.acc['receivable'], debit: '0.00', credit: '115.00' }]);
    expect((await post(co, j1.json.id)).status).toBe(200);
    expect(await net(co, co.acc['receivable']!)).toBe('0.00');
    expect(await net(co, co.acc['sales_revenue']!)).toBe('-100.00');

    const gov = await invoice(co, 'purchase', co.government);
    const s2 = await settle(co, gov.obligationId, await bankTx(co, '2026-03-22', '-23.00'), '23.00');
    const j2 = await prefill(co, s2);
    expect(j2.status).toBe(201);
    expect((await lines(j2.json.id))[0]).toMatchObject({ account_id: co.acc['payable'], debit: '23.00' });
  });

  it('partial payments each get their own prefilled journal and leave the right remainder', async () => {
    const co = await setup('part');
    const inv = await invoice(co, 'purchase');
    const s1 = await settle(co, inv.obligationId, await bankTx(co, '2026-03-20', '-10.00'), '10.00');
    const s2 = await settle(co, inv.obligationId, await bankTx(co, '2026-03-25', '-5.00'), '5.00');
    const j1 = await prefill(co, s1);
    const j2 = await prefill(co, s2);
    expect((await lines(j1.json.id))[0]).toMatchObject({ debit: '10.00' });
    expect((await lines(j2.json.id))[0]).toMatchObject({ debit: '5.00' });
    expect((await post(co, j1.json.id)).status).toBe(200);
    expect(await net(co, co.acc['payable']!)).toBe('-13.00'); // 23 - 10; the second is not posted yet
    expect((await post(co, j2.json.id)).status).toBe(200);
    expect(await net(co, co.acc['payable']!)).toBe('-8.00');
    const ob = (await co.owner.client.req('GET', '/obligations')).json.obligations.find((o: { id: string }) => o.id === inv.obligationId);
    expect(ob).toMatchObject({ state: 'partial', remaining_amount: '8.00', pending_settlement_journals: 0 });
  });

  it('refuses duplicates: a second prefill, a concurrent prefill and a manual journal for the same settlement', async () => {
    const co = await setup('dup');
    const inv = await invoice(co, 'purchase');
    const s = await settle(co, inv.obligationId, await bankTx(co, '2026-03-20', '-23.00'), '23.00');
    const both = await Promise.all([prefill(co, s), prefill(co, s), prefill(co, s)]);
    expect(both.map(r => r.status).sort()).toEqual([201, 409, 409]);
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='obligation_settlement'", [co.id])).toBe(1);
    const manual = await co.owner.client.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: '2026-03-20', description: 'dup', source_type: 'obligation_settlement', source_id: s });
    expect(manual.status).toBe(409);
  });

  it('blocks prefilling with an actionable code: missing mapping, ambiguous recognition, unlinked bank, manual obligation, wrong company', async () => {
    const co = await setup('blk');
    const inv = await invoice(co, 'purchase');
    const s = await settle(co, inv.obligationId, await bankTx(co, '2026-03-20', '-23.00'), '23.00');
    // mapping changed after the invoice was recognised -> the control account is ambiguous
    await h.q("UPDATE invoice_account_mappings SET account_id=(SELECT id FROM accounts WHERE company_id=$1 AND code='M-vat_output') WHERE company_id=$1 AND mapping_key='payable'", [co.id]);
    let r = await prefill(co, s);
    expect(r.status).toBe(409); expect(r.json.code).toBe('SETTLEMENT_JOURNAL_RECOGNITION_AMBIGUOUS');
    await h.q("DELETE FROM invoice_account_mappings WHERE company_id=$1 AND mapping_key='payable'", [co.id]);
    r = await prefill(co, s);
    expect(r.json.code).toBe('SETTLEMENT_JOURNAL_MAPPING_MISSING');
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='obligation_settlement'", [co.id])).toBe(0);

    const unlinked = await setup('unl', { link: false });
    const inv2 = await invoice(unlinked, 'purchase');
    const s2 = await settle(unlinked, inv2.obligationId, await bankTx(unlinked, '2026-03-20', '-23.00'), '23.00');
    expect((await prefill(unlinked, s2)).json.code).toBe('SETTLEMENT_JOURNAL_BANK_UNLINKED');

    const manual = await setup('man');
    const ob = (await h.q<{ id: string }>("INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,50,'2026-03-01','confirmed','manual',$3) RETURNING id", [manual.id, manual.supplier, manual.owner.id]))[0]!.id;
    const s3 = await settle(manual, ob, await bankTx(manual, '2026-03-20', '-50.00'), '50.00');
    expect((await prefill(manual, s3)).json.code).toBe('SETTLEMENT_JOURNAL_SOURCE_UNSUPPORTED');

    // another company's settlement is invisible
    expect((await prefill(manual, s2)).json.code).toBe('SETTLEMENT_JOURNAL_NOT_FOUND');
  });

  it('blocks prefilling when the invoice has a credit/debit note', async () => {
    const co = await setup('adj');
    const inv = await invoice(co, 'purchase');
    const s = await settle(co, inv.obligationId, await bankTx(co, '2026-03-20', '-23.00'), '23.00');
    await h.q(`INSERT INTO invoice_adjustments(company_id,original_invoice_id,direction,adjustment_type,adjustment_date,external_number,counterparty_id,status,subtotal_amount,vat_amount,total_amount,reason,created_by_user_id)
               VALUES($1,$2,'purchase','credit','2026-03-15','CN-1',$3,'draft',1,0,1,'price correction',$4)`, [co.id, inv.invoiceId, co.supplier, co.owner.id]);
    expect((await prefill(co, s)).json.code).toBe('SETTLEMENT_JOURNAL_ADJUSTMENTS_EXIST');
  });

  it('posting re-verifies bank line, amount, direction, accounts and period for any journal on the settlement', async () => {
    const co = await setup('pst');
    const inv = await invoice(co, 'purchase');
    const s = await settle(co, inv.obligationId, await bankTx(co, '2026-03-20', '-23.00'), '23.00');
    const mk = async (rows: Array<[string, string, string]>, date = '2026-03-20') => {
      const c = await co.owner.client.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: '2026-03-20', description: 'x', source_type: 'obligation_settlement', source_id: s });
      expect(c.status).toBe(201);
      const put = await co.owner.client.req('PUT', `/journals/${c.json.id}/lines`, { lines: rows.map(([account_id, debit, credit]) => ({ account_id, debit, credit, memo: null })) }, { 'if-match': '1' });
      expect(put.status).toBe(200);
      if (date !== '2026-03-20') await h.q('UPDATE journal_entries SET accounting_date=$2 WHERE id=$1', [c.json.id, date]);
      return c.json.id as string;
    };
    const rejected = async (rows: Array<[string, string, string]>, date?: string) => {
      const id = await mk(rows, date);
      const r = await post(co, id);
      await h.q('DELETE FROM journal_lines WHERE journal_entry_id=$1', [id]);
      await h.q('DELETE FROM journal_entries WHERE id=$1', [id]);
      return r;
    };
    const { payable, bankGl, other } = co.acc as Record<string, string>;
    expect((await rejected([[payable!, '23', '0'], [other!, '0', '23']])).status).toBe(400); // does not move the linked bank account
    expect((await rejected([[bankGl!, '23', '0'], [payable!, '0', '23']])).status).toBe(400); // receipt direction for a payment
    expect((await rejected([[payable!, '22', '0'], [bankGl!, '0', '22']])).status).toBe(400); // wrong amount
    expect((await rejected([[other!, '23', '0'], [bankGl!, '0', '23']])).status).toBe(400); // bank right, control account wrong
    expect((await rejected([[payable!, '23', '0'], [bankGl!, '0', '23']], '2026-03-21')).status).toBe(400); // settlement date changed
    const ok = await mk([[payable!, '23', '0'], [bankGl!, '0', '23']]);
    expect((await post(co, ok)).status).toBe(200);
  });

  it('period guard: a closed fiscal year stops posting a prepared draft', async () => {
    const co = await setup('per');
    const inv = await invoice(co, 'purchase');
    const s = await settle(co, inv.obligationId, await bankTx(co, '2026-03-20', '-10.00'), '10.00');
    const s2 = await settle(co, inv.obligationId, await bankTx(co, '2026-03-21', '-13.00'), '13.00');
    const drafted = await prefill(co, s);
    expect(drafted.status).toBe(201);
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1", [co.fy]);
    const p = await post(co, drafted.json.id);
    expect(p.status).toBe(409);
    expect(p.json.code).toBe('FISCAL_YEAR_CLOSED');
    const late = await prefill(co, s2);
    expect(late.status).toBe(409);
    expect(late.json.code).toBe('FISCAL_YEAR_CLOSED');
    expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_id=$2", [co.id, s2])).toBe(0);
  });
  describe('posting cannot bypass exact control-account validation after the plan changes', () => {
    async function drafted(label: string) {
      const co = await setup(label);
      const inv = await invoice(co, 'purchase');
      const s = await settle(co, inv.obligationId, await bankTx(co, '2026-03-20', '-23.00'), '23.00');
      const d = await prefill(co, s);
      expect(d.status).toBe(201);
      return { co, inv, s, journal: d.json.id as string };
    }
    const refused = async (co: Co, journal: string, code: string) => {
      const r = await post(co, journal);
      expect(r.status, JSON.stringify(r.json)).toBe(400);
      expect(r.json.error).toContain(code);
      expect((await h.q<{ status: string }>('SELECT status FROM journal_entries WHERE id=$1', [journal]))[0]!.status).toBe('draft');
    };

    it('mapping changed to another account: the prepared draft is refused (recognition ambiguous)', async () => {
      const { co, journal } = await drafted('mc');
      await h.q("UPDATE invoice_account_mappings SET account_id=$2 WHERE company_id=$1 AND mapping_key='payable'", [co.id, co.acc['other']]);
      await refused(co, journal, 'SETTLEMENT_JOURNAL_MAPPING_MISSING');
    });
    it('mapping removed: refused', async () => {
      const { co, journal } = await drafted('mr');
      await h.q("DELETE FROM invoice_account_mappings WHERE company_id=$1 AND mapping_key='payable'", [co.id]);
      await refused(co, journal, 'SETTLEMENT_JOURNAL_MAPPING_MISSING');
    });
    it('mapping moved to another valid liability after recognition: refused as ambiguous, even for a hand-built journal on the new account', async () => {
      const { co, journal } = await drafted('amb');
      const other = await h.account(co.id, 'AP2', 'liability', 'current_liability');
      await h.q("UPDATE invoice_account_mappings SET account_id=$2 WHERE company_id=$1 AND mapping_key='payable'", [co.id, other]);
      await refused(co, journal, 'SETTLEMENT_JOURNAL_RECOGNITION_AMBIGUOUS');
      await h.q('UPDATE journal_lines SET account_id=$2 WHERE journal_entry_id=$1 AND debit>0', [journal, other]);
      await refused(co, journal, 'SETTLEMENT_JOURNAL_RECOGNITION_AMBIGUOUS');
    });
    it('bank ledger link removed: refused', async () => {
      const { co, journal } = await drafted('bl');
      await h.q("UPDATE bank_account_ledger_links SET valid_to='2026-01-15', ended_by=$2, ended_at=NOW() WHERE company_id=$1", [co.id, co.owner.id]);
      const r = await post(co, journal);
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/not linked/i);
    });
    it('a prepared draft whose lines were edited to other accounts is refused', async () => {
      const { co, journal } = await drafted('ed');
      await h.q('UPDATE journal_lines SET account_id=$2 WHERE journal_entry_id=$1 AND debit>0', [journal, co.acc['other']]);
      await refused(co, journal, 'SETTLEMENT_JOURNAL_LINES_MISMATCH');
    });
    it('credit/debit note introduced after the draft: the explicit manual exception applies (bank-line rule still enforced)', async () => {
      const { co, inv, journal } = await drafted('cn');
      await h.q(`INSERT INTO invoice_adjustments(company_id,original_invoice_id,direction,adjustment_type,adjustment_date,external_number,counterparty_id,status,subtotal_amount,vat_amount,total_amount,reason,created_by_user_id)
                 VALUES($1,$2,'purchase','credit','2026-03-15','CN-9',$3,'draft',1,0,1,'price correction',$4)`, [co.id, inv.invoiceId, co.supplier, co.owner.id]);
      // a journal that does not move the linked bank account is still refused...
      await h.q('UPDATE journal_lines SET account_id=$2 WHERE journal_entry_id=$1 AND credit>0', [journal, co.acc['other']]);
      expect((await post(co, journal)).status).toBe(400);
      // ...a reviewed journal that does is the controlled manual path
      await h.q('UPDATE journal_lines SET account_id=$2 WHERE journal_entry_id=$1 AND credit>0', [journal, co.acc['bankGl']]);
      expect((await post(co, journal)).status).toBe(200);
    });
  });

  it('government payments: supported only for invoice-backed obligations; manual government obligations stay on the explicit manual path', async () => {
    const co = await setup('gov');
    // invoice-backed government payable (counterparty type government) -> prefilled with the payable mapping
    const inv = await invoice(co, 'purchase', co.government);
    const s = await settle(co, inv.obligationId, await bankTx(co, '2026-03-20', '-23.00'), '23.00');
    expect((await prefill(co, s)).status).toBe(201);
    // manual government obligation with payment reference and period (G5 fields): no approved treatment -> prefill refused, manual exception only
    const ob = (await h.q<{ id: string }>("INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,500,'2026-03-01','confirmed','manual',$3) RETURNING id", [co.id, co.government, co.owner.id]))[0]!.id;
    const r = await co.owner.client.req('POST', `/obligations/${ob}/settlements`, { bank_transaction_id: await bankTx(co, '2026-03-22', '-500.00'), amount: '500.00', payment_reference: 'SADAD-1', period_from: '2026-02-01', period_to: '2026-02-28' });
    expect(r.status).toBe(201);
    const blocked = await prefill(co, r.json.id);
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('SETTLEMENT_JOURNAL_SOURCE_UNSUPPORTED');
    const blank = await co.owner.client.req('POST', '/journals', { fiscal_year_id: co.fy, accounting_date: '2026-03-22', description: 'manual', source_type: 'obligation_settlement', source_id: r.json.id });
    expect(blank.status).toBe(201);
    const wrong = await co.owner.client.req('PUT', `/journals/${blank.json.id}/lines`, { lines: [{ account_id: co.acc['payable'], debit: '500', credit: '0', memo: null }, { account_id: co.acc['other'], debit: '0', credit: '500', memo: null }] }, { 'if-match': '1' });
    expect(wrong.status).toBe(200);
    expect((await post(co, blank.json.id)).status).toBe(400); // bank-line rule applies to the exception too
  });
});
