import { PoolClient } from 'pg';

/**
 * Accounting contract of in-year partner transactions (Owner policy 2026-10-18). Pure rules plus two mapping/journal checks, shared by
 * the partner-transaction service (which prepares the journal) and the canonical journal-posting contract (which refuses any other shape).
 *
 * Every transaction is a two-line journal between the partner-side account and the company's cash/bank account:
 *   capital_contribution / current_deposit / loan_received  : Dr cash-or-bank, Cr partner account
 *   current_withdrawal / loan_repayment                     : Dr partner account, Cr cash-or-bank
 * An ordinary withdrawal always hits the partner's individual CURRENT account; capital reduction and distributions are separate workflows.
 */
export const PARTNER_TRANSACTION_TYPES = ['capital_contribution', 'current_deposit', 'current_withdrawal', 'loan_received', 'loan_repayment'] as const;
export type PartnerTransactionType = (typeof PARTNER_TRANSACTION_TYPES)[number];
export const PARTNER_MAPPING_KEYS = ['capital', 'current', 'loan'] as const;
export type PartnerMappingKey = (typeof PARTNER_MAPPING_KEYS)[number];

/** Account types each mapping accepts. 'current' accepts equity or liability: the accountant's own classification is respected, not decided here. */
export const PARTNER_MAPPING_ACCOUNT_TYPES: Record<PartnerMappingKey | 'cash', readonly string[]> = {
  capital: ['equity'], current: ['equity', 'liability'], loan: ['liability'], cash: ['asset'],
};

export const isPartnerTransactionType = (v: unknown): v is PartnerTransactionType => typeof v === 'string' && (PARTNER_TRANSACTION_TYPES as readonly string[]).includes(v);
export const isPartnerMappingKey = (v: unknown): v is PartnerMappingKey => typeof v === 'string' && (PARTNER_MAPPING_KEYS as readonly string[]).includes(v);

export function mappingKeyFor(type: PartnerTransactionType): PartnerMappingKey {
  return type === 'capital_contribution' ? 'capital' : type === 'loan_received' || type === 'loan_repayment' ? 'loan' : 'current';
}
/** +1 when money flows from the partner to the company (increases what the company holds/owes for the partner), -1 for the reverse. */
export const inflow = (type: PartnerTransactionType): boolean => type === 'capital_contribution' || type === 'current_deposit' || type === 'loan_received';

export function journalSides(type: PartnerTransactionType, partnerAccountId: string, cashAccountId: string): { debit: string; credit: string } {
  return inflow(type) ? { debit: cashAccountId, credit: partnerAccountId } : { debit: partnerAccountId, credit: cashAccountId };
}

type Runner = Pick<PoolClient, 'query'>;

/**
 * The configured, still-valid accounts for a transaction (active, same company, matching type). A missing or invalid mapping yields null for that side.
 * With lock=true the mapping and account rows are share-locked for the surrounding transaction, so a concurrent mapping change waits for posting.
 */
export async function loadPartnerPostingAccounts(
  client: Runner, companyId: string, partnerId: string, type: PartnerTransactionType, bankAccountId: string | null, lock: boolean,
): Promise<{ partnerAccountId: string | null; cashAccountId: string | null }> {
  const key = mappingKeyFor(type);
  const suffix = lock ? ' FOR SHARE OF m, a' : '';
  const partner = (await client.query<{ account_id: string }>(
    `SELECT m.account_id FROM partner_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id
      WHERE m.company_id=$1 AND m.partner_id=$2 AND m.mapping_key=$3 AND a.is_active AND a.account_type = ANY($4::text[])${suffix}`,
    [companyId, partnerId, key, PARTNER_MAPPING_ACCOUNT_TYPES[key]])).rows[0];
  const cash = (await client.query<{ account_id: string }>(
    `SELECT m.account_id FROM partner_cash_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id
      WHERE m.company_id=$1 AND m.bank_account_id IS NOT DISTINCT FROM $2::uuid AND a.is_active AND a.account_type = ANY($3::text[])${suffix}`,
    [companyId, bankAccountId, PARTNER_MAPPING_ACCOUNT_TYPES.cash])).rows[0];
  return { partnerAccountId: partner?.account_id ?? null, cashAccountId: cash?.account_id ?? null };
}

/**
 * True only when the journal is exactly the two-line entry the transaction's current valid mappings produce, for the transaction amount.
 * Used by journal posting, so a hand-made journal pointing at a partner transaction cannot be posted with arbitrary accounts.
 */
export async function partnerJournalIsExact(
  client: Runner, companyId: string, journalId: string, context: Record<string, unknown>, amount: string,
): Promise<boolean> {
  const type = context['transaction_type'];
  const partnerId = context['partner_id'];
  if (!isPartnerTransactionType(type) || typeof partnerId !== 'string') return false;
  const bank = typeof context['bank_account_id'] === 'string' ? context['bank_account_id'] : null;
  const valid = await loadPartnerPostingAccounts(client, companyId, partnerId, type, bank, false);
  if (!valid.partnerAccountId || !valid.cashAccountId || valid.partnerAccountId === valid.cashAccountId) return false;
  if (context['partner_account_id'] !== valid.partnerAccountId || context['cash_account_id'] !== valid.cashAccountId) return false;
  const { debit, credit } = journalSides(type, valid.partnerAccountId, valid.cashAccountId);
  const row = (await client.query<{ valid: boolean }>(
    `SELECT COUNT(*)=2 AND BOOL_AND((l.account_id=$2 AND l.debit=$4::numeric AND l.credit=0) OR (l.account_id=$3 AND l.credit=$4::numeric AND l.debit=0)) valid
       FROM journal_lines l WHERE l.journal_entry_id=$1 AND l.company_id=$5`,
    [journalId, debit, credit, amount, companyId])).rows[0];
  return row?.valid === true;
}

/**
 * True only when the journal is the exact mirror of the transaction's original journal: same two accounts, debit and credit swapped, same amounts.
 * Partner reversals are sourced journals (the generic reversal link is reserved for manual journals by migration 080), so this is their shape guard.
 */
export async function partnerReversalJournalIsExact(client: Runner, companyId: string, journalId: string, context: Record<string, unknown>): Promise<boolean> {
  const original = context['original_journal_id'];
  if (typeof original !== 'string' || context['reversal_journal_id'] !== journalId) return false;
  const row = (await client.query<{ valid: boolean }>(
    `SELECT COUNT(*)=2 AND (SELECT COUNT(*) FROM journal_lines WHERE journal_entry_id=$2 AND company_id=$3)=2
            AND BOOL_AND(EXISTS (SELECT 1 FROM journal_lines o WHERE o.journal_entry_id=$2 AND o.company_id=$3 AND o.account_id=l.account_id AND o.debit=l.credit AND o.credit=l.debit)) valid
       FROM journal_lines l WHERE l.journal_entry_id=$1 AND l.company_id=$3`,
    [journalId, original, companyId])).rows[0];
  return row?.valid === true;
}
