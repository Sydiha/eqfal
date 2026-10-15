import { PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { JournalPostingNotFoundError, JournalPostingValidationError, JournalReversalBlockedError } from './journal-posting-errors';
import { postJournalInTransaction } from './journal-posting';

export const JOURNAL_REVERSAL_REASON_MAX = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Original = {
  id: string; fiscal_year_id: string; accounting_date: string; description: string; reference: string | null;
  source_type: string | null; entry_type: string; status: string; reversal_of_journal_id: string | null;
};
type OriginalLine = { account_id: string; debit: string; credit: string; memo: string | null; sequence: number };

const validDate = (value: unknown): value is string =>
  typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/**
 * Reverses a POSTED MANUAL journal by creating a separate, balanced journal with debit and credit swapped.
 * The original is only read (locked); it is never updated or deleted. Caller owns the transaction.
 * Eligible: posted, standard, no source (not system-generated), not itself a reversal, not already reversed.
 * The reversal is posted through the canonical posting contract, so the fiscal-year guard, the monthly-period guard,
 * the balance check and the inactive-account check all apply to the reversal date.
 */
export async function reverseJournalInTransaction(
  client: PoolClient, companyId: string, actor: string, journalId: string, input: { accountingDate: unknown; reason: unknown },
) {
  if (!validDate(input.accountingDate)) throw new JournalPostingValidationError('A valid reversal date is required');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason || reason.length > JOURNAL_REVERSAL_REASON_MAX) throw new JournalPostingValidationError('A reversal reason of 1-500 characters is required');
  const reversalDate = input.accountingDate;

  // Row lock serialises concurrent reversal requests for the same journal (the unique index is the final backstop).
  const original = (await client.query<Original>(
    'SELECT id,fiscal_year_id,accounting_date::text,description,reference,source_type,entry_type,status,reversal_of_journal_id FROM journal_entries WHERE id=$1 AND company_id=$2 FOR UPDATE',
    [journalId, companyId],
  )).rows[0];
  if (!original) throw new JournalPostingNotFoundError();
  if (original.status !== 'posted') throw new JournalReversalBlockedError('JOURNAL_REVERSAL_NOT_POSTED', 'Only a posted journal can be reversed');
  if (original.source_type !== null) {
    throw new JournalReversalBlockedError('JOURNAL_REVERSAL_SYSTEM_GENERATED',
      'System-generated journals cannot be reversed directly; use the correction workflow of their source (e.g. credit/debit note)');
  }
  if (original.entry_type !== 'standard') throw new JournalReversalBlockedError('JOURNAL_REVERSAL_NOT_ELIGIBLE', 'Opening balance journals cannot be reversed here');
  if (original.reversal_of_journal_id) throw new JournalReversalBlockedError('JOURNAL_IS_REVERSAL', 'A reversal journal cannot be reversed');

  const existing = (await client.query<{ id: string }>('SELECT id FROM journal_entries WHERE company_id=$1 AND reversal_of_journal_id=$2', [companyId, journalId])).rows[0];
  if (existing) throw new JournalReversalBlockedError('JOURNAL_ALREADY_REVERSED', 'This journal has already been reversed');

  if (reversalDate < original.accounting_date) throw new JournalPostingValidationError('Reversal date cannot precede the original journal date');

  const lines = (await client.query<OriginalLine>(
    'SELECT account_id,debit::text,credit::text,memo,sequence FROM journal_lines WHERE journal_entry_id=$1 AND company_id=$2 ORDER BY sequence,id', [journalId, companyId])).rows;
  // VAT-tagged lines feed VAT reporting; reversing them silently would change tax figures, which needs its own tax-policy workflow.
  if (lines.some((line) => line.memo === 'VAT_INPUT' || line.memo === 'VAT_OUTPUT')) {
    throw new JournalReversalBlockedError('JOURNAL_REVERSAL_VAT_TAGGED', 'Journals carrying VAT recognition lines cannot be reversed here');
  }
  // Operational dependency: nothing else may point at this journal (fixed-asset schedule, opening balance, periodic adjustment).
  const dependent = await client.query(
    `SELECT 1 FROM asset_depreciation_entries WHERE company_id=$1 AND journal_entry_id=$2
     UNION ALL SELECT 1 FROM opening_balance_reviews WHERE company_id=$1 AND journal_entry_id=$2
     UNION ALL SELECT 1 FROM periodic_adjustment_schedule WHERE company_id=$1 AND journal_entry_id=$2 LIMIT 1`, [companyId, journalId]);
  if (dependent.rowCount) throw new JournalReversalBlockedError('JOURNAL_REVERSAL_HAS_DEPENDENCY', 'Another record depends on this journal and it cannot be reversed here');

  const year = (await client.query<{ id: string }>(
    'SELECT id FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date', [companyId, reversalDate])).rows[0];
  if (!year) throw new JournalPostingValidationError('No fiscal year covers the reversal date');

  const description = `Reversal of journal: ${original.description}`.slice(0, 500);
  const reference = (original.reference ? `REV ${original.reference}` : `REV ${journalId.slice(0, 8)}`).slice(0, 200);
  const reversal = (await client.query<{ id: string }>(
    `INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,reference,entry_type,status,created_by,reversal_of_journal_id,reversal_reason)
     VALUES($1,$2,$3,$4,$5,'standard','draft',$6,$7,$8) RETURNING id`,
    [companyId, year.id, reversalDate, description, reference, actor, journalId, reason])).rows[0]!;
  for (const line of lines) {
    await client.query(
      'INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [companyId, reversal.id, line.account_id, line.credit, line.debit, line.memo, line.sequence]);
  }
  const posted = await postJournalInTransaction(client, companyId, actor, reversal.id);

  await new AuditLogRepository().logEvent({
    company_id: companyId, actor_user_id: actor, action: 'journal.reverse', entity_type: 'journal_entry', entity_id: journalId,
    before_data: { status: 'posted', reversed: false },
    after_data: { status: 'posted', reversed: true, reversal_journal_id: reversal.id, reversal_date: reversalDate, lines: lines.length },
    reason,
  }, client);
  return { original_journal_id: journalId, reversal: posted };
}
