import { PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable } from '../monthly-close/accounting-period.guard';
import { isOperationalSourceType, operationalSourceQuery, OperationalSource, JournalOperationalSourceType } from './operational-sources';
import { enforceVatRecognition } from './vat-recognition';

export class JournalPostingValidationError extends Error {}
export class JournalPostingNotFoundError extends Error {}
export class JournalPostingConflictError extends Error {}

type Journal = {
  id: string;
  company_id: string;
  fiscal_year_id: string;
  accounting_date: string;
  description: string;
  reference: string | null;
  source_type: string | null;
  source_id: string | null;
  entry_type: 'standard' | 'opening_balance';
  status: 'draft' | 'posted';
  created_by: string;
  posted_by: string | null;
  posted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

async function source(companyId: string, type: string, id: string, client: PoolClient) {
  if (type !== 'periodic_adjustment' && !isOperationalSourceType(type)) {
    throw new JournalPostingValidationError('Unsupported operational source type');
  }
  const row = (
    await client.query<OperationalSource>(operationalSourceQuery(type as JournalOperationalSourceType), [id, companyId])
  ).rows[0];
  if (!row) throw new JournalPostingNotFoundError();
  return row;
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
): Promise<Journal> {
  const audit = new AuditLogRepository();
  const journal = (
    await client.query<Journal>(
      'SELECT *,accounting_date::text FROM journal_entries WHERE id=$1 AND company_id=$2 FOR UPDATE',
      [id, companyId],
    )
  ).rows[0];
  if (!journal) throw new JournalPostingNotFoundError();
  if (journal.status !== 'draft') throw new JournalPostingConflictError('Journal is already posted');

  const year = (
    await client.query<{ start_date: string; end_date: string }>(
      'SELECT start_date::text,end_date::text FROM fiscal_years WHERE id=$1 AND company_id=$2',
      [journal.fiscal_year_id, companyId],
    )
  ).rows[0];
  if (!year || journal.accounting_date < year.start_date || journal.accounting_date > year.end_date) {
    throw new JournalPostingValidationError('Accounting date must be within the fiscal year');
  }
  if (journal.entry_type === 'opening_balance' && journal.accounting_date !== year.start_date) {
    throw new JournalPostingValidationError('Opening balance date must equal fiscal year start');
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
