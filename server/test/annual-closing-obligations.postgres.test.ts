import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { AnnualClosingService } from '../src/modules/annual-closing/annual-closing.service';
import { packageManifest } from '../src/modules/annual-closing/annual-package.service';

// Uses synthetic records in a disposable PostgreSQL database supplied by DATABASE_URL.
const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('annual obligations as-of cutoff (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;

  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { if (h) await h.close(); });

  it('uses settlement accounting dates for direct and document AR/AP and passes corrected balances through readiness and package manifest', async () => {
    const owner = await h.user('obligations-asof');
    const company = await h.company('obligations-asof', owner.id);
    const fy = await h.fiscalYear(company, 'FY2025', '2025-01-01', '2025-12-31');
    const nextFy = await h.fiscalYear(company, 'FY2026', '2026-01-01', '2026-12-31');
    const ar = await h.account(company, 'ASOF-AR', 'asset', 'current_asset');
    const ap = await h.account(company, 'ASOF-AP', 'liability', 'current_liability');
    const bank = await h.account(company, 'ASOF-BANK', 'asset', 'current_asset');
    const equity = await h.account(company, 'ASOF-EQUITY', 'equity', 'equity');
    const counterparty = (await h.q<{ id: string }>(
      "INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Synthetic counterparty','other',$2) RETURNING id",
      [company, owner.id],
    ))[0]!.id;
    const bankAccount = (await h.q<{ id: string }>(
      "INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Synthetic bank','SAR',$2) RETURNING id",
      [company, owner.id],
    ))[0]!.id;
    const batch = (await h.q<{ id: string }>(
      `INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by)
       VALUES($1,$2,'synthetic.csv','text/csv','csv',$3,$4,'confirmed',$5) RETURNING id`,
      [company, bankAccount, `synthetic/${h.run}`, 'a'.repeat(64), owner.id],
    ))[0]!.id;
    let rowNo = 0;
    const transaction = async (date: string, amount: string) => {
      rowNo++;
      return (await h.q<{ id: string }>(
        `INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,currency_code,source_row_number,fingerprint,fingerprint_strength)
         VALUES($1,$2,$3,$4,$5,'SAR',$6,$7,'weak') RETURNING id`,
        [company, bankAccount, batch, date, amount, rowNo, `synthetic-${h.run}-${rowNo}`],
      ))[0]!.id;
    };
    const obligation = async (direction: 'receivable' | 'payable', amount: string, source: 'manual' | 'document', documentId: string | null = null) =>
      (await h.q<{ id: string }>(
        `INSERT INTO obligations(company_id,direction,counterparty_id,document_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id)
         VALUES($1,$2,$3,$4,$5,'2025-01-01','confirmed',$6,$7) RETURNING id`,
        [company, direction, counterparty, documentId, amount, source, owner.id],
      ))[0]!.id;
    const document = async (type: 'sale' | 'purchase') =>
      (await h.q<{ id: string }>(
        `INSERT INTO documents(company_id,uploaded_by_user_id,status,original_filename,mime_type,size_bytes,storage_key,sha256,document_type,document_date)
         VALUES($1,$2,'approved',$3,'application/pdf',1,$4,$5,$6,'2025-01-01') RETURNING id`,
        [company, owner.id, `${type}-${h.run}.pdf`, `synthetic/${type}-${h.run}`, (type === 'sale' ? 'b' : 'c').repeat(64), type],
      ))[0]!.id;
    const directSettlement = async (obligationId: string, date: string, amount: string) => {
      const tx = await transaction(date, amount);
      const settlementId = (await h.q<{ id: string }>(
        `INSERT INTO obligation_settlements(company_id,obligation_id,bank_transaction_id,amount,created_by_user_id,created_at)
         VALUES($1,$2,$3,$4,$5,'2026-11-08T12:00:00Z') RETURNING id`,
        [company, obligationId, tx, amount, owner.id],
      ))[0]!.id;
      return { tx, settlementId };
    };
    const documentSettlement = async (docId: string, date: string, amount: string) => {
      const tx = await transaction(date, amount);
      await h.q('INSERT INTO bank_transaction_matches(company_id,bank_transaction_id,document_id,matched_by_user_id) VALUES($1,$2,$3,$4)', [company, tx, docId, owner.id]);
      const settlementId = (await h.q<{ id: string }>(
        `INSERT INTO document_settlements(company_id,document_id,bank_transaction_id,amount,created_by_user_id,created_at)
         VALUES($1,$2,$3,$4,$5,'2026-11-08T12:00:00Z') RETURNING id`,
        [company, docId, tx, amount, owner.id],
      ))[0]!.id;
      return { tx, settlementId };
    };

    // Direct AR: effective in FY 2025 (but entered later) plus a post-year-end settlement.
    const arDirect = await obligation('receivable', '1000.00', 'manual');
    const arDirectInYear = await directSettlement(arDirect, '2025-03-01', '400.00');
    const arDirectAfter = await directSettlement(arDirect, '2026-01-05', '200.00');
    // Document AR: partial settlement effective on the cutoff date.
    const arDoc = await document('sale');
    const arDocumentObligation = await obligation('receivable', '300.00', 'document', arDoc);
    const arDocInYear = await documentSettlement(arDoc, '2025-12-31', '100.00');
    // AP independently covers direct in-year and document post-year-end settlements.
    const apDirect = await obligation('payable', '800.00', 'manual');
    const apDirectInYear = await directSettlement(apDirect, '2025-06-30', '300.00');
    const apDoc = await document('purchase');
    const apDocumentObligation = await obligation('payable', '200.00', 'document', apDoc);
    const apDocAfter = await documentSettlement(apDoc, '2026-02-01', '50.00');
    // An unmatched FY transaction has no settlement linkage and must not reduce either balance.
    await transaction('2025-08-01', '77.00');

    await h.postedJournal(company, fy, '2025-01-01', owner.id, [[ar, '1000.00', '0'], [equity, '0', '1000.00']], { source_type: 'obligation', source_id: arDirect });
    await h.postedJournal(company, fy, '2025-01-01', owner.id, [[ar, '300.00', '0'], [equity, '0', '300.00']], { source_type: 'obligation', source_id: arDocumentObligation });
    await h.postedJournal(company, fy, '2025-01-01', owner.id, [[equity, '800.00', '0'], [ap, '0', '800.00']], { source_type: 'obligation', source_id: apDirect });
    await h.postedJournal(company, fy, '2025-01-01', owner.id, [[equity, '200.00', '0'], [ap, '0', '200.00']], { source_type: 'obligation', source_id: apDocumentObligation });
    await h.postedJournal(company, fy, '2025-03-01', owner.id, [[bank, '400.00', '0'], [ar, '0', '400.00']], { source_type: 'obligation_settlement', source_id: arDirectInYear.settlementId });
    await h.postedJournal(company, fy, '2025-12-31', owner.id, [[bank, '100.00', '0'], [ar, '0', '100.00']], { source_type: 'document_settlement', source_id: arDocInYear.settlementId });
    await h.postedJournal(company, fy, '2025-06-30', owner.id, [[ap, '300.00', '0'], [bank, '0', '300.00']], { source_type: 'obligation_settlement', source_id: apDirectInYear.settlementId });
    await h.postedJournal(company, nextFy, '2026-01-05', owner.id, [[bank, '200.00', '0'], [ar, '0', '200.00']], { source_type: 'obligation_settlement', source_id: arDirectAfter.settlementId });
    await h.postedJournal(company, nextFy, '2026-02-01', owner.id, [[ap, '50.00', '0'], [bank, '0', '50.00']], { source_type: 'document_settlement', source_id: apDocAfter.settlementId });

    const readiness = await new AnnualClosingService(h.db).readiness(company, fy);
    const summary = readiness.domains.receivables_payables!.summary;
    expect(summary).toMatchObject({ open_receivable_balance: '800.00', open_payable_balance: '700.00' });
    const manifest = packageManifest(readiness, '2026-11-08T00:00:00.000Z');
    expect(manifest.find(item => item.section === 'receivables_payables')?.summary).toMatchObject({
      open_receivable_balance: '800.00', open_payable_balance: '700.00',
    });
    const ledger = (await h.q<{ receivable: string; payable: string }>(
      `SELECT
         COALESCE(SUM(l.debit-l.credit) FILTER (WHERE l.account_id=$3),0)::text receivable,
         COALESCE(SUM(l.credit-l.debit) FILTER (WHERE l.account_id=$4),0)::text payable
       FROM journal_entries j JOIN journal_lines l ON l.company_id=j.company_id AND l.journal_entry_id=j.id
       WHERE j.company_id=$1 AND j.fiscal_year_id=$2 AND j.status='posted'`,
      [company, fy, ar, ap],
    ))[0]!;
    expect(ledger).toEqual({ receivable: '800.00', payable: '700.00' });
    expect(summary.open_receivable_balance).toBe(ledger.receivable);
    expect(summary.open_payable_balance).toBe(ledger.payable);

    // Operational settlement state updates immediately, but close remains blocked until its source journal is posted.
    await directSettlement(arDirect, '2025-07-01', '50.00');
    const pendingReadiness = await new AnnualClosingService(h.db).readiness(company, fy);
    expect(pendingReadiness.domains.receivables_payables!.summary.open_receivable_balance).toBe('750.00');
    expect(pendingReadiness.domains.ledger!.summary.unposted_operational_sources).toBe(1);
    const client = await h.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM fiscal_years WHERE id=$1 AND company_id=$2 FOR UPDATE', [fy, company]);
      const { getFiscalYearCloseReadiness, loadFiscalYearBounds, lockFiscalYearCloseScope } = await import('../src/modules/fiscal-years/fiscal-year-close-readiness');
      const year = await loadFiscalYearBounds(client, company, fy);
      await lockFiscalYearCloseScope(client, company, year);
      const close = await getFiscalYearCloseReadiness(client, company, year);
      expect(close.blockers.map(item => item.code)).toContain('unposted_operational_sources');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
