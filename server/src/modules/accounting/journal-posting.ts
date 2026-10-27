import { PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable } from '../monthly-close/accounting-period.guard';
import { assertCustodyJournalControls } from './custody-posting';
import { isOperationalSourceType, operationalSourceQuery, OperationalSource, JournalOperationalSourceType } from './operational-sources';
import { enforceVatRecognition } from './vat-recognition';
import { invoiceVatRecognitionIsExact } from '../vat/vat-invoice';
import { invoiceAdjustmentJournalIsExact } from '../vat/vat-invoice-adjustment';
import { JournalPostingValidationError, JournalPostingNotFoundError, JournalPostingConflictError, OpeningBalanceJournalBlockedError, LedgerSourceAuthorityBlockedError, OPENING_BALANCE_MANUAL_CODE, OPENING_BALANCE_CONTEXT_CODE, CARRYFORWARD_RECONCILIATION_CODE } from './journal-posting-errors';
import { verifyCarryforwardReview } from '../fiscal-years/fiscal-year-carryforward';
import { assertLedgerSourceAuthority, assertFiscalYearNotInCutoverPath, assertCutoverPostingContext } from './ledger-source-authority';
import { assertFiscalYearOpen, FiscalYearClosedError } from './fiscal-year-posting.guard';
import { partnerJournalIsExact, partnerReversalJournalIsExact } from './partner-transaction-posting';
import { isPersonalPaymentSourceType, personalPaymentJournalIsExact, personalReimbursementJournalIsExact, resolveBankLedgerAccount } from './personal-payment-posting';

export { JournalPostingValidationError, JournalPostingNotFoundError, JournalPostingConflictError, OpeningBalanceJournalBlockedError, LedgerSourceAuthorityBlockedError };
export { FiscalYearClosedError };

type Journal = {
  id: string;
  company_id: string;
  fiscal_year_id: string;
  accounting_date: string;
  description: string;
  reference: string | null;
  source_type: string | null;
  source_id: string | null;
  entry_type: 'standard' | 'opening_balance' | 'cutover_balance';
  status: 'draft' | 'posted' | 'voided';
  created_by: string;
  posted_by: string | null;
  posted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

async function source(companyId: string, type: string, id: string, client: PoolClient) {
  if (type !== 'periodic_adjustment' && type !== 'partner_transaction' && type !== 'partner_transaction_reversal' && !isPersonalPaymentSourceType(type) && !isOperationalSourceType(type)) {
    throw new JournalPostingValidationError('Unsupported operational source type');
  }
  const row = (
    await client.query<OperationalSource>(operationalSourceQuery(type as JournalOperationalSourceType), [id, companyId])
  ).rows[0];
  if (!row) throw new JournalPostingNotFoundError();
  return row;
}

/**
 * In-process only (never derived from a request): the opening-balance review that is approving this journal. An
 * `opening_balance` journal is postable only when this review is verified inside the posting transaction.
 */
export type InternalPostingContext = { openingBalanceReviewId?: string; cutoverAuthorityId?: string };

async function assertOpeningBalanceReviewContext(
  client: PoolClient,
  companyId: string,
  journal: Pick<Journal, 'id' | 'fiscal_year_id'>,
  reviewId: string | undefined,
): Promise<void> {
  const blocked = (message: string, code = OPENING_BALANCE_CONTEXT_CODE) => new OpeningBalanceJournalBlockedError(code, message);
  if (!reviewId) {
    throw blocked('Opening balance journals can only be posted by the approved opening balance review workflow', OPENING_BALANCE_MANUAL_CODE);
  }
  const review = (
    await client.query<{ fiscal_year_id: string; status: string; journal_entry_id: string | null }>(
      'SELECT fiscal_year_id,status,journal_entry_id FROM opening_balance_reviews WHERE id=$1 AND company_id=$2 FOR UPDATE',
      [reviewId, companyId],
    )
  ).rows[0];
  if (!review || review.fiscal_year_id !== journal.fiscal_year_id) throw blocked('Opening balance review does not match the journal');
  if (review.status !== 'in_review' || review.journal_entry_id) throw blocked('Opening balance review is not awaiting approval');
  const duplicate = await client.query(
    "SELECT 1 FROM journal_entries WHERE company_id=$1 AND fiscal_year_id=$2 AND entry_type='opening_balance' AND status='posted' AND id<>$3 LIMIT 1",
    [companyId, journal.fiscal_year_id, journal.id],
  );
  if (duplicate.rowCount) throw blocked('A posted opening balance journal already exists for this fiscal year');
  // Path exclusivity: a fiscal year governed by an active external-reference range follows the cut-over path, never the opening path.
  await assertFiscalYearNotInCutoverPath(client, companyId, journal.fiscal_year_id);
  // B1: a carry-forward review is posted only when it equals the originating year's closing position exactly. Every opening-balance
  // journal reaches the ledger through this function, so no other approval or posting path can skip it. Mismatches are never corrected.
  const carry = await verifyCarryforwardReview(client, companyId, reviewId, journal.id);
  if (carry) {
    throw new OpeningBalanceJournalBlockedError(CARRYFORWARD_RECONCILIATION_CODE,
      `Carry-forward opening balance does not reconcile with the closing balances of the originating fiscal year (${carry.reason})`, carry.mismatches);
  }
}

/**
 * D2 / R9: a document-settlement journal must move the bank ledger account that is linked to the settlement's bank account on the transaction date,
 * in the bank transaction's direction (receipt = net debit, payment = net credit), by exactly the allocation amount. Each allocation of a bank
 * transaction is checked on its own, so the allocations of one bank row together move the bank account by the bank amount. Already posted journals
 * are never re-checked.
 */
async function assertDocumentSettlementBankLine(client: PoolClient, companyId: string, journalId: string, source: OperationalSource): Promise<void> {
  const bankAccountId = source.context?.['bank_account_id'];
  const bankAmount = source.context?.['bank_amount'];
  if (typeof bankAccountId !== 'string' || typeof bankAmount !== 'string') {
    throw new JournalPostingValidationError('Document settlement bank account cannot be determined');
  }
  const ledgerAccountId = await resolveBankLedgerAccount(client, companyId, bankAccountId, source.accounting_date, true);
  if (!ledgerAccountId) {
    throw new JournalPostingValidationError('Document settlement bank account is not linked to an active bank ledger account on the transaction date');
  }
  const row = (await client.query<{ ok: boolean }>(
    `SELECT COALESCE(SUM(debit-credit),0)::numeric(18,2) = (CASE WHEN $4::numeric < 0 THEN -1 ELSE 1 END * $5::numeric)::numeric(18,2) ok
       FROM journal_lines WHERE journal_entry_id=$1 AND company_id=$2 AND account_id=$3`,
    [journalId, companyId, ledgerAccountId, bankAmount, source.amount],
  )).rows[0];
  if (row?.ok !== true) {
    throw new JournalPostingValidationError('Document settlement journal must debit (receipt) or credit (payment) the linked bank ledger account by the settlement amount');
  }
}

/**
 * Canonical journal-posting contract.
 * Caller owns the surrounding transaction. This lets workflows such as
 * Opening Balance Review post a journal atomically with their own state change
 * without creating a second, weaker posting path.
 */
export async function postJournalInTransaction(
  client: PoolClient,
  companyId: string,
  actor: string,
  id: string,
  internal: InternalPostingContext = {},
): Promise<Journal> {
  const audit = new AuditLogRepository();
  const journal = (
    await client.query<Journal>(
      'SELECT *,accounting_date::text FROM journal_entries WHERE id=$1 AND company_id=$2 FOR UPDATE',
      [id, companyId],
    )
  ).rows[0];
  if (!journal) throw new JournalPostingNotFoundError();
  if (journal.status === 'voided') throw new JournalPostingConflictError('Journal is voided and cannot be posted');
  if (journal.status !== 'draft') throw new JournalPostingConflictError('Journal is already posted');

  const year = await assertFiscalYearOpen(companyId, journal.fiscal_year_id, journal.accounting_date, client);
  if (journal.entry_type === 'opening_balance' && journal.accounting_date !== year.start_date) {
    throw new JournalPostingValidationError('Opening balance date must equal fiscal year start');
  }
  if (journal.entry_type === 'opening_balance') {
    await assertOpeningBalanceReviewContext(client, companyId, journal, internal.openingBalanceReviewId);
  }

  if (journal.entry_type === 'cutover_balance') {
    // In-process only (the DRAFT range being activated). Posted before the range turns active, so the active-range block never applies to it.
    await assertCutoverPostingContext(client, companyId, journal, internal.cutoverAuthorityId);
  }

  if (journal.entry_type === 'standard' && !journal.source_type && !journal.source_id) {
    const today = (
      await client.query<{ today: string }>('SELECT CURRENT_DATE::text AS today')
    ).rows[0]!.today;
    if (journal.accounting_date > today) {
      throw new JournalPostingValidationError('Manual journal accounting date is in the future');
    }
  }

  await assertAccountingDateWritable(companyId, journal.accounting_date, client);
  // Runs after the month lock above so a concurrent authority change is strictly ordered with this posting (no new lock).
  await assertLedgerSourceAuthority(client, companyId, journal.accounting_date);

  const summary = (
    await client.query<{ count: string; debit: string; credit: string; active: string }>(
      `SELECT COUNT(*)::text count,
              COALESCE(SUM(l.debit),0)::text debit,
              COALESCE(SUM(l.credit),0)::text credit,
              COUNT(*) FILTER(WHERE a.is_active)::text active
       FROM journal_lines l
       JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
       WHERE l.journal_entry_id=$1 AND l.company_id=$2`,
      [id, companyId],
    )
  ).rows[0]!;

  if (Number(summary.count) < 2) throw new JournalPostingValidationError('A posted journal requires at least two lines');
  if (summary.count !== summary.active) throw new JournalPostingValidationError('Inactive accounts cannot receive postings');
  if (summary.debit !== summary.credit) throw new JournalPostingValidationError('Journal is not balanced');

  if (journal.source_type && journal.source_id) {
    const operationalSource = await source(companyId, journal.source_type, journal.source_id, client);
    if (journal.accounting_date !== operationalSource.accounting_date) {
      throw new JournalPostingValidationError('Operational source date changed');
    }
    const amount = (
      await client.query<{ matches: boolean }>(
        'SELECT $1::numeric(18,2)=$2::numeric(18,2) matches',
        [summary.debit, operationalSource.amount],
      )
    ).rows[0]!.matches;
    if (!amount) throw new JournalPostingValidationError('Journal total must match the operational source amount');

    // Invoice VAT (V1 sales, V2 purchases). A journal that carries invoice VAT is postable only when it matches the immutable reviewed
    // VAT snapshot exactly (one VAT line per standard-rate group: VAT_OUTPUT liability credit for sales, VAT_INPUT asset debit for
    // purchases; no tolerance). A purchase approved before V2 has no snapshot: it stays postable only when it carries no VAT.
    const invoiceId = journal.source_type === 'obligation' ? operationalSource.context?.invoice_id : undefined;
    if (typeof invoiceId === 'string') {
      const row = (await client.query<{ direction: string; reviewed: boolean }>(
        'SELECT i.direction, EXISTS (SELECT 1 FROM invoice_vat_reviews r WHERE r.invoice_id=i.id AND r.company_id=i.company_id) reviewed FROM invoices i WHERE i.id=$1 AND i.company_id=$2', [invoiceId, companyId])).rows[0];
      if (row?.direction === 'sales' || row?.reviewed) {
        if (!(await invoiceVatRecognitionIsExact(client, companyId, id, invoiceId))) {
          throw new JournalPostingConflictError('Invoice VAT recognition does not match the reviewed VAT snapshot; this journal cannot be posted');
        }
      } else if (Number(operationalSource.context?.invoice_vat_amount ?? 0) > 0) {
        throw new JournalPostingConflictError('Purchase invoice VAT has no reviewed VAT snapshot; this journal cannot be posted');
      }
    }

    // Externally issued credit/debit note (F4): its VAT lines must match the approved note exactly (same rule as invoice VAT, mirrored for credit notes).
    if (journal.source_type === 'invoice_adjustment' && !(await invoiceAdjustmentJournalIsExact(client, companyId, id, journal.source_id))) {
      throw new JournalPostingConflictError('Credit/debit note VAT recognition does not match the approved note; this journal cannot be posted');
    }

    if (journal.source_type === 'asset_depreciation') {
      const mapped = (
        await client.query<{ valid: boolean }>(
          `SELECT COUNT(*)=2 AND BOOL_AND(
             (l.account_id=$2 AND l.debit=$4::numeric AND l.credit=0)
             OR (l.account_id=$3 AND l.credit=$4::numeric AND l.debit=0)
           ) valid
           FROM journal_lines l
           WHERE l.journal_entry_id=$1 AND l.company_id=$5`,
          [
            id,
            operationalSource.context.depreciation_expense_account_id,
            operationalSource.context.accumulated_depreciation_account_id,
            operationalSource.amount,
            companyId,
          ],
        )
      ).rows[0]?.valid;
      if (!mapped) {
        throw new JournalPostingValidationError(
          'Depreciation journal must use the configured expense and accumulated depreciation accounts',
        );
      }
    }

    if (journal.source_type === 'periodic_adjustment') {
      const adjustmentType = String(operationalSource.context.adjustment_type ?? '');
      const expense = adjustmentType === 'accrued_expense' || adjustmentType === 'prepaid_expense';
      const debitAccount = expense
        ? operationalSource.context.pnl_account_id
        : operationalSource.context.balance_account_id;
      const creditAccount = expense
        ? operationalSource.context.balance_account_id
        : operationalSource.context.pnl_account_id;
      const mapped = (
        await client.query<{ valid: boolean }>(
          `SELECT COUNT(*)=2 AND BOOL_AND(
             (l.account_id=$2 AND l.debit=$4::numeric AND l.credit=0)
             OR (l.account_id=$3 AND l.credit=$4::numeric AND l.debit=0)
           ) valid
           FROM journal_lines l
           WHERE l.journal_entry_id=$1 AND l.company_id=$5`,
          [id, debitAccount, creditAccount, operationalSource.amount, companyId],
        )
      ).rows[0]?.valid;
      if (!mapped) {
        throw new JournalPostingValidationError(
          'Periodic adjustment journal must use the configured balance-sheet and P&L accounts',
        );
      }
    }

    if (journal.source_type === 'document_settlement') {
      await assertDocumentSettlementBankLine(client, companyId, id, operationalSource);
    }

    await assertCustodyJournalControls(client, companyId, id, operationalSource);

    if (journal.source_type === 'partner_transaction' && !(await partnerJournalIsExact(client, companyId, id, operationalSource.context, operationalSource.amount))) {
      throw new JournalPostingValidationError('Partner transaction journal must use the configured partner and cash/bank accounts');
    }

    if (journal.source_type === 'personal_payment' && !(await personalPaymentJournalIsExact(client, companyId, id, operationalSource.context, operationalSource.amount))) {
      throw new JournalPostingValidationError('Personal payment journal must use the payer account and the approved debit account');
    }

    if (journal.source_type === 'personal_payment_reimbursement' && !(await personalReimbursementJournalIsExact(client, companyId, id, operationalSource.context, operationalSource.amount))) {
      throw new JournalPostingValidationError('Personal payment reimbursement journal must be debit payer account and credit the bank ledger account');
    }

    if (journal.source_type === 'partner_transaction_reversal' && !(await partnerReversalJournalIsExact(client, companyId, id, operationalSource.context))) {
      throw new JournalPostingValidationError('Partner transaction reversal journal must mirror the original journal');
    }

    await enforceVatRecognition(companyId, id, journal.source_type, journal.source_id, client);
  }

  const after = (
    await client.query<Journal>(
      "UPDATE journal_entries SET status='posted',posted_by=$3,posted_at=NOW(),updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status='draft' RETURNING *,accounting_date::text",
      [id, companyId, actor],
    )
  ).rows[0];
  if (!after) throw new JournalPostingConflictError('Journal is already posted');

  if (journal.source_type === 'asset_depreciation' && journal.source_id) {
    const linked = (
      await client.query(
        "UPDATE asset_depreciation_entries SET status='posted',journal_entry_id=$3,updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status='pending' RETURNING asset_id",
        [journal.source_id, companyId, id],
      )
    ).rows[0];
    if (!linked) throw new JournalPostingConflictError('Depreciation source is already consumed');
    if (
      !(await client.query("SELECT 1 FROM asset_depreciation_entries WHERE company_id=$1 AND asset_id=$2 AND status='pending'", [companyId, linked.asset_id])).rowCount
    ) {
      await client.query(
        "UPDATE fixed_assets SET status='fully_depreciated',updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status='active'",
        [linked.asset_id, companyId],
      );
    }
    await audit.logEvent(
      {
        company_id: companyId,
        actor_user_id: actor,
        action: 'asset.depreciation.post',
        entity_type: 'asset_depreciation_entry',
        entity_id: journal.source_id,
        before_data: { status: 'pending' },
        after_data: { status: 'posted', journal_entry_id: id },
      },
      client,
    );
  }

  await audit.logEvent(
    {
      company_id: companyId,
      actor_user_id: actor,
      action: 'journal.post',
      entity_type: 'journal_entry',
      entity_id: id,
      before_data: { status: 'draft' },
      after_data: { status: 'posted', posted_by: actor, posted_at: after.posted_at },
    },
    client,
  );

  return after;
}
