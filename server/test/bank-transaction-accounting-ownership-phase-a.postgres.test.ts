import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;

describeDatabase('bank transaction accounting ownership Phase A (PostgreSQL)', () => {
  let h: Awaited<ReturnType<typeof startHarness>>;

  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  async function fixture(label: string) {
    const owner = await h.user(`${label}-owner`);
    const company = await h.company(label, owner.id);
    const otherCompany = await h.company(`${label}-other`, owner.id);
    const fiscalYear = await h.fiscalYear(company, 'FY2026', '2026-01-01', '2026-12-31');
    const otherFiscalYear = await h.fiscalYear(otherCompany, 'FY2026', '2026-01-01', '2026-12-31');
    const bankLedger = await h.account(company, `${label}-bank`, 'asset', 'current_asset');
    const offset = await h.account(company, `${label}-offset`, 'liability', 'current_liability');
    const otherBankLedger = await h.account(otherCompany, `${label}-other-bank`, 'asset', 'current_asset');
    const bankAccount = (await h.q<{ id: string }>(
      "INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id",
      [company, owner.id],
    ))[0]!.id;
    const otherBankAccount = (await h.q<{ id: string }>(
      "INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Other','SAR',$2) RETURNING id",
      [otherCompany, owner.id],
    ))[0]!.id;
    await h.q("UPDATE accounts SET cash_role='cash' WHERE id=ANY($1::uuid[])", [[bankLedger, otherBankLedger]]);
    await h.q(
      "INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4),($5,$6,$7,'2026-01-01',$4)",
      [company, bankAccount, bankLedger, owner.id, otherCompany, otherBankAccount, otherBankLedger],
    );
    const bankTransaction = (await h.q<{ id: string }>(
      `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id)
       VALUES($1,$2,'2026-03-10',-100,'SAR','Phase A','phase-a',$3,'strong','manual','other',$4) RETURNING id`,
      [company, bankAccount, randomUUID().replaceAll('-', ''), owner.id],
    ))[0]!.id;
    const otherBankTransaction = (await h.q<{ id: string }>(
      `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id)
       VALUES($1,$2,'2026-03-10',-100,'SAR','Other','phase-a-other',$3,'strong','manual','other',$4) RETURNING id`,
      [otherCompany, otherBankAccount, randomUUID().replaceAll('-', ''), owner.id],
    ))[0]!.id;
    const journal = (await h.q<{ id: string }>(
      "INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,'2026-03-10','Phase A journal',$3) RETURNING id",
      [company, fiscalYear, owner.id],
    ))[0]!.id;
    const otherJournal = (await h.q<{ id: string }>(
      "INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,'2026-03-10','Other journal',$3) RETURNING id",
      [otherCompany, otherFiscalYear, owner.id],
    ))[0]!.id;
    return { owner, company, otherCompany, fiscalYear, bankLedger, offset, otherBankLedger, bankTransaction, otherBankTransaction, journal, otherJournal };
  }

  it('keeps claims staged and supports partial claims with several claims on one journal', async () => {
    const x = await fixture('ownership-shape');
    const first = (await h.q<{ id: string; enforcement_state: string }>(
      `INSERT INTO bank_transaction_accounting_claims(company_id,bank_transaction_id,owner_type,owner_id,signed_amount,created_by)
       VALUES($1,$2,'payroll_settlement',$3,-40,$4) RETURNING id,enforcement_state`,
      [x.company, x.bankTransaction, randomUUID(), x.owner.id],
    ))[0]!;
    const second = (await h.q<{ id: string }>(
      `INSERT INTO bank_transaction_accounting_claims(company_id,bank_transaction_id,owner_type,owner_id,signed_amount,created_by)
       VALUES($1,$2,'payroll_settlement',$3,-60,$4) RETURNING id`,
      [x.company, x.bankTransaction, randomUUID(), x.owner.id],
    ))[0]!;
    expect(first.enforcement_state).toBe('staged');
    await h.q(
      `INSERT INTO bank_transaction_journal_evidence(claim_id,company_id,journal_entry_id,bank_ledger_account_id)
       VALUES($1,$3,$2,$4),($5,$3,$2,$4)`,
      [first.id, x.journal, x.company, x.bankLedger, second.id],
    );
    expect(await h.count('SELECT COUNT(*)::text n FROM bank_transaction_journal_evidence WHERE company_id=$1 AND journal_entry_id=$2', [x.company, x.journal])).toBe(2);
    await expect(h.q(
      'INSERT INTO bank_transaction_journal_evidence(claim_id,company_id,journal_entry_id,bank_ledger_account_id) VALUES($1,$2,$3,$4)',
      [first.id, x.company, x.journal, x.bankLedger],
    )).rejects.toThrow();
    expect((await h.q<{ name: string | null }>("SELECT to_regclass('bank_transaction_accounting_verifications')::text name"))[0]!.name).toBeNull();
  });

  it('enforces staged state, nonzero amounts, and one claim per owner identity', async () => {
    const x = await fixture('ownership-constraints');
    const ownerId = randomUUID();
    await expect(h.q(
      `INSERT INTO bank_transaction_accounting_claims(company_id,bank_transaction_id,owner_type,owner_id,signed_amount,enforcement_state,created_by)
       VALUES($1,$2,'manual_journal',$3,-1,'authoritative',$4)`,
      [x.company, x.bankTransaction, ownerId, x.owner.id],
    )).rejects.toThrow();
    await expect(h.q(
      `INSERT INTO bank_transaction_accounting_claims(company_id,bank_transaction_id,owner_type,owner_id,signed_amount,created_by)
       VALUES($1,$2,'manual_journal',$3,0,$4)`,
      [x.company, x.bankTransaction, ownerId, x.owner.id],
    )).rejects.toThrow();
    await h.q(
      `INSERT INTO bank_transaction_accounting_claims(company_id,bank_transaction_id,owner_type,owner_id,signed_amount,created_by)
       VALUES($1,$2,'manual_journal',$3,-1,$4)`,
      [x.company, x.bankTransaction, ownerId, x.owner.id],
    );
    await expect(h.q(
      `INSERT INTO bank_transaction_accounting_claims(company_id,bank_transaction_id,owner_type,owner_id,signed_amount,created_by)
       VALUES($1,$2,'manual_journal',$3,-2,$4)`,
      [x.company, x.bankTransaction, ownerId, x.owner.id],
    )).rejects.toThrow();
  });

  it('enforces company-scoped bank transaction, journal, account, and claim references', async () => {
    const x = await fixture('ownership-tenancy');
    await expect(h.q(
      `INSERT INTO bank_transaction_accounting_claims(company_id,bank_transaction_id,owner_type,owner_id,signed_amount,created_by)
       VALUES($1,$2,'manual_journal',$3,-1,$4)`,
      [x.company, x.otherBankTransaction, randomUUID(), x.owner.id],
    )).rejects.toThrow();
    const claim = (await h.q<{ id: string }>(
      `INSERT INTO bank_transaction_accounting_claims(company_id,bank_transaction_id,owner_type,owner_id,signed_amount,created_by)
       VALUES($1,$2,'manual_journal',$3,-1,$4) RETURNING id`,
      [x.company, x.bankTransaction, randomUUID(), x.owner.id],
    ))[0]!;
    await expect(h.q(
      'INSERT INTO bank_transaction_journal_evidence(claim_id,company_id,journal_entry_id,bank_ledger_account_id) VALUES($1,$2,$3,$4)',
      [claim.id, x.company, x.otherJournal, x.bankLedger],
    )).rejects.toThrow();
    await expect(h.q(
      'INSERT INTO bank_transaction_journal_evidence(claim_id,company_id,journal_entry_id,bank_ledger_account_id) VALUES($1,$2,$3,$4)',
      [claim.id, x.company, x.journal, x.otherBankLedger],
    )).rejects.toThrow();
    await expect(h.q(
      'INSERT INTO bank_transaction_journal_evidence(claim_id,company_id,journal_entry_id,bank_ledger_account_id) VALUES($1,$2,$3,$4)',
      [claim.id, x.otherCompany, x.otherJournal, x.otherBankLedger],
    )).rejects.toThrow();
  });

  it('protects claims and evidence from update and delete', async () => {
    const x = await fixture('ownership-immutable');
    const claim = (await h.q<{ id: string }>(
      `INSERT INTO bank_transaction_accounting_claims(company_id,bank_transaction_id,owner_type,owner_id,signed_amount,created_by)
       VALUES($1,$2,'manual_journal',$3,-1,$4) RETURNING id`,
      [x.company, x.bankTransaction, randomUUID(), x.owner.id],
    ))[0]!;
    await h.q(
      'INSERT INTO bank_transaction_journal_evidence(claim_id,company_id,journal_entry_id,bank_ledger_account_id) VALUES($1,$2,$3,$4)',
      [claim.id, x.company, x.journal, x.bankLedger],
    );
    await expect(h.q('UPDATE bank_transaction_accounting_claims SET signed_amount=-2 WHERE id=$1', [claim.id])).rejects.toThrow(/immutable/);
    await expect(h.q('DELETE FROM bank_transaction_accounting_claims WHERE id=$1', [claim.id])).rejects.toThrow(/immutable/);
    await expect(h.q('UPDATE bank_transaction_journal_evidence SET bank_ledger_account_id=$2 WHERE claim_id=$1', [claim.id, x.offset])).rejects.toThrow(/immutable/);
    await expect(h.q('DELETE FROM bank_transaction_journal_evidence WHERE claim_id=$1', [claim.id])).rejects.toThrow(/immutable/);
  });

  it('does not change existing manual journal posting behavior', async () => {
    const x = await fixture('ownership-inert');
    await h.q(
      'INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,0,10,1),($1,$2,$4,10,0,2)',
      [x.company, x.journal, x.bankLedger, x.offset],
    );
    const client = await h.db.connect();
    try {
      await client.query('BEGIN');
      const { postJournalInTransaction } = await import('../src/modules/accounting/journal-posting');
      const posted = await postJournalInTransaction(client, x.company, x.owner.id, x.journal);
      await client.query('COMMIT');
      expect(posted.status).toBe('posted');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await h.count('SELECT COUNT(*)::text n FROM bank_transaction_accounting_claims WHERE company_id=$1', [x.company])).toBe(0);
  });
});
