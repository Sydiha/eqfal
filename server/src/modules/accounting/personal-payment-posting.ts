import { PoolClient } from 'pg';
import { PARTNER_MAPPING_ACCOUNT_TYPES } from './partner-transaction-posting';

/**
 * Accounting contract of personal expense payments and their reimbursement (T3, Owner policy 2026-10-18). Rules and checks shared by the personal-payment
 * service (which prepares the journal) and the canonical journal-posting contract (which refuses any other shape).
 *
 *   personal_payment (new_expense)          : Dr expense account              / Cr payer account
 *   personal_payment (existing_obligation)  : Dr the obligation's payable account / Cr payer account (reclassification, no new expense and no new VAT)
 *   personal_payment_reimbursement          : Dr payer account                / Cr company bank ledger account (no expense line)
 * The payer account is the partner's individual CURRENT account for a partner payer, otherwise the payer's own mapped payable (liability) account.
 */
type Runner = Pick<PoolClient, 'query'>;

export const PERSONAL_PAYMENT_SOURCE_TYPES = ['personal_payment', 'personal_payment_reimbursement'] as const;
export const isPersonalPaymentSourceType = (v: unknown): v is (typeof PERSONAL_PAYMENT_SOURCE_TYPES)[number] =>
  typeof v === 'string' && (PERSONAL_PAYMENT_SOURCE_TYPES as readonly string[]).includes(v);

export type PayerAccount = { kind: 'partner' | 'employee'; accountId: string | null };

/**
 * The still-valid account the payer is recognized through (active, same company, right type), or null when the mapping is missing or invalid.
 * Never guessed: a partner payer uses only the partner's 'current' mapping; an employee payer only its own payable account.
 * With lock=true the mapping and account rows are share-locked, so a concurrent mapping change waits for the surrounding transaction.
 */
export async function resolvePayerAccount(client: Runner, companyId: string, payerId: string, lock: boolean): Promise<PayerAccount | null> {
  const suffix = lock ? ' FOR SHARE' : '';
  const payer = (await client.query<{ partner_id: string | null; payable_account_id: string | null }>(
    `SELECT partner_id, payable_account_id FROM personal_payers WHERE id=$1 AND company_id=$2${suffix}`, [payerId, companyId])).rows[0];
  if (!payer) return null;
  if (payer.partner_id) {
    const row = (await client.query<{ account_id: string }>(
      `SELECT m.account_id FROM partner_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id
        WHERE m.company_id=$1 AND m.partner_id=$2 AND m.mapping_key='current' AND a.is_active AND a.account_type = ANY($3::text[])${lock ? ' FOR SHARE OF m, a' : ''}`,
      [companyId, payer.partner_id, PARTNER_MAPPING_ACCOUNT_TYPES.current])).rows[0];
    return { kind: 'partner', accountId: row?.account_id ?? null };
  }
  if (!payer.payable_account_id) return { kind: 'employee', accountId: null };
  const row = (await client.query<{ id: string }>(
    `SELECT id FROM accounts WHERE id=$1 AND company_id=$2 AND is_active AND account_type='liability'${suffix}`, [payer.payable_account_id, companyId])).rows[0];
  return { kind: 'employee', accountId: row?.id ?? null };
}

/** The company's ledger account for a bank account on a date (T2 bank_account_ledger_links), active asset only; null when not linked on that date. */
export async function resolveBankLedgerAccount(client: Runner, companyId: string, bankAccountId: string, date: string, lock: boolean): Promise<string | null> {
  const row = (await client.query<{ account_id: string }>(
    `SELECT l.account_id FROM bank_account_ledger_links l JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
      WHERE l.company_id=$1 AND l.bank_account_id=$2 AND l.valid_from<=$3::date AND (l.valid_to IS NULL OR l.valid_to>=$3::date)
        AND a.is_active AND a.account_type = ANY($4::text[])${lock ? ' FOR SHARE OF l, a' : ''}`,
    [companyId, bankAccountId, date, PARTNER_MAPPING_ACCOUNT_TYPES.cash])).rows[0];
  return row?.account_id ?? null;
}

async function twoLineJournalIsExact(client: Runner, companyId: string, journalId: string, debit: unknown, credit: unknown, amount: string): Promise<boolean> {
  if (typeof debit !== 'string' || typeof credit !== 'string' || debit === credit) return false;
  const row = (await client.query<{ valid: boolean }>(
    `SELECT COUNT(*)=2 AND BOOL_AND((l.account_id=$2 AND l.debit=$4::numeric AND l.credit=0) OR (l.account_id=$3 AND l.credit=$4::numeric AND l.debit=0)) valid
       FROM journal_lines l WHERE l.journal_entry_id=$1 AND l.company_id=$5`,
    [journalId, debit, credit, amount, companyId])).rows[0];
  return row?.valid === true;
}

/**
 * True only when the journal is exactly the two-line entry of the payment's snapshotted accounts, and those accounts are what the current valid
 * mappings and the treatment require (expense account type for a new expense; a liability for a reclassification; the payer's account on the credit side).
 */
export async function personalPaymentJournalIsExact(client: Runner, companyId: string, journalId: string, context: Record<string, unknown>, amount: string): Promise<boolean> {
  const payerId = context['payer_id'];
  const treatment = context['treatment'];
  const debit = context['debit_account_id'];
  const credit = context['credit_account_id'];
  if (typeof payerId !== 'string' || typeof debit !== 'string' || typeof credit !== 'string') return false;
  const payer = await resolvePayerAccount(client, companyId, payerId, false);
  if (!payer?.accountId || payer.accountId !== credit) return false;
  const types = treatment === 'new_expense' ? ['expense'] : treatment === 'existing_obligation' ? ['liability'] : null;
  if (!types) return false;
  const debitOk = (await client.query('SELECT 1 FROM accounts WHERE id=$1 AND company_id=$2 AND is_active AND account_type = ANY($3::text[])', [debit, companyId, types])).rowCount === 1;
  return debitOk && twoLineJournalIsExact(client, companyId, journalId, debit, credit, amount);
}

/** True only for the exact Dr payer account / Cr bank ledger account entry; the debit must be the account the approved payment credited. */
export async function personalReimbursementJournalIsExact(client: Runner, companyId: string, journalId: string, context: Record<string, unknown>, amount: string): Promise<boolean> {
  const debit = context['debit_account_id'];
  const credit = context['credit_account_id'];
  const bankAccountId = context['bank_account_id'];
  const date = context['reimbursement_date'];
  const paymentCredit = context['payment_credit_account_id'];
  if (typeof bankAccountId !== 'string' || typeof date !== 'string' || typeof debit !== 'string' || debit !== paymentCredit) return false;
  const bankLedger = await resolveBankLedgerAccount(client, companyId, bankAccountId, date, false);
  if (!bankLedger || bankLedger !== credit) return false;
  return twoLineJournalIsExact(client, companyId, journalId, debit, credit, amount);
}
