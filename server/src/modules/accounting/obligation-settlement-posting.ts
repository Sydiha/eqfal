import { PoolClient } from 'pg';
import { loadValidMappings } from '../invoices/invoice-account-mapping.service';
import { resolveBankLedgerAccount } from './personal-payment-posting';

/**
 * Accounting contract of an invoice-backed obligation settlement (supplier payment, customer receipt, government payment).
 *   payable (purchase invoice)    : Dr payable account  / Cr linked bank ledger account
 *   receivable (sales invoice)    : Dr linked bank ledger account / Cr receivable account
 * The invoice's own expense / revenue / VAT lines are recognised once, by the invoice journal; this journal only moves the control account against cash.
 * Nothing here guesses: a missing mapping, an ambiguous recognition journal, an adjusted invoice or an unlinked bank account blocks the preparation.
 */
export const SETTLEMENT_JOURNAL_ERROR_CODES = [
  'SETTLEMENT_JOURNAL_NOT_FOUND',
  'SETTLEMENT_JOURNAL_SOURCE_UNSUPPORTED',
  'SETTLEMENT_JOURNAL_OBLIGATION_NOT_ELIGIBLE',
  'SETTLEMENT_JOURNAL_ADJUSTMENTS_EXIST',
  'SETTLEMENT_JOURNAL_MAPPING_MISSING',
  'SETTLEMENT_JOURNAL_RECOGNITION_AMBIGUOUS',
  'SETTLEMENT_JOURNAL_BANK_MISMATCH',
  'SETTLEMENT_JOURNAL_BANK_UNLINKED',
  'SETTLEMENT_JOURNAL_LINES_MISMATCH',
] as const;
export type SettlementJournalErrorCode = (typeof SETTLEMENT_JOURNAL_ERROR_CODES)[number];

export class SettlementJournalBlockedError extends Error {
  constructor(readonly code: SettlementJournalErrorCode, message: string, readonly details?: Record<string, unknown>) { super(message); }
}

export type SettlementJournalPlan = {
  settlementId: string;
  obligationId: string;
  accountingDate: string;
  amount: string;
  direction: 'receivable' | 'payable';
  bankAccountId: string;
  bankLedgerAccountId: string;
  controlAccountId: string;
  debitAccountId: string;
  creditAccountId: string;
  description: string;
};

type Row = {
  amount: string; obligation_id: string; source_type: string; invoice_id: string | null; direction: 'receivable' | 'payable'; verification_status: string;
  is_cancelled: boolean; original_amount: string; bank_account_id: string; bank_amount: string; transaction_date: string; counterparty: string; reference: string | null;
};

/** Resolves the one journal an eligible settlement may carry, or throws SettlementJournalBlockedError. lock=true share-locks the rows it relies on. */
export async function planObligationSettlementJournal(client: Pick<PoolClient, 'query'>, companyId: string, settlementId: string, lock: boolean): Promise<SettlementJournalPlan> {
  const row = (await client.query<Row>(
    `SELECT s.amount::text, s.obligation_id, o.source_type, o.invoice_id, o.direction, o.verification_status, o.is_cancelled, o.original_amount::text,
            t.bank_account_id, t.amount::text bank_amount, t.transaction_date::text, c.name counterparty, t.bank_reference reference
       FROM obligation_settlements s
       JOIN obligations o ON o.id=s.obligation_id AND o.company_id=s.company_id
       JOIN counterparties c ON c.id=o.counterparty_id AND c.company_id=o.company_id
       JOIN bank_transactions t ON t.id=s.bank_transaction_id AND t.company_id=s.company_id
      WHERE s.id=$1 AND s.company_id=$2${lock ? ' FOR SHARE OF s, o' : ''}`, [settlementId, companyId])).rows[0];
  if (!row) throw new SettlementJournalBlockedError('SETTLEMENT_JOURNAL_NOT_FOUND', 'Settlement not found');
  if (row.source_type !== 'invoice' || !row.invoice_id) {
    throw new SettlementJournalBlockedError('SETTLEMENT_JOURNAL_SOURCE_UNSUPPORTED', 'Only settlements of invoice obligations can be prefilled; prepare this journal manually');
  }
  if (row.is_cancelled || row.verification_status !== 'confirmed') {
    throw new SettlementJournalBlockedError('SETTLEMENT_JOURNAL_OBLIGATION_NOT_ELIGIBLE', 'The obligation is cancelled or not confirmed');
  }
  const adjustments = (await client.query<{ n: string }>(
    "SELECT COUNT(*)::text n FROM invoice_adjustments WHERE company_id=$1 AND original_invoice_id=$2 AND status<>'cancelled'", [companyId, row.invoice_id])).rows[0]!.n;
  if (Number(adjustments) > 0) {
    throw new SettlementJournalBlockedError('SETTLEMENT_JOURNAL_ADJUSTMENTS_EXIST', 'The invoice has credit/debit notes; prepare this settlement journal manually');
  }

  const bankCents = BigInt(Math.round(Number(row.bank_amount) * 100));
  const settleCents = BigInt(Math.round(Number(row.amount) * 100));
  const absBank = bankCents < 0n ? -bankCents : bankCents;
  const directionOk = row.direction === 'payable' ? bankCents < 0n : bankCents > 0n;
  if (!directionOk || absBank !== settleCents) {
    throw new SettlementJournalBlockedError('SETTLEMENT_JOURNAL_BANK_MISMATCH', 'The bank transaction direction or amount does not match the settlement');
  }

  const key = row.direction === 'payable' ? 'payable' : 'receivable';
  const control = (await loadValidMappings(client as PoolClient, companyId))[key];
  if (!control) {
    throw new SettlementJournalBlockedError('SETTLEMENT_JOURNAL_MAPPING_MISSING', `The ${key} account mapping is missing or invalid`, { missing_key: key });
  }
  // The control account must be the one the posted invoice journal actually used (a mapping changed after approval makes the treatment ambiguous).
  const recognised = (await client.query<{ n: string }>(
    `SELECT COUNT(*)::text n FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id AND l.company_id=j.company_id
      WHERE j.company_id=$1 AND j.source_type='obligation' AND j.source_id=$2 AND j.status='posted' AND l.account_id=$3
        AND ${row.direction === 'payable' ? 'l.credit' : 'l.debit'}=$4::numeric AND ${row.direction === 'payable' ? 'l.debit' : 'l.credit'}=0`,
    [companyId, row.obligation_id, control, row.original_amount])).rows[0]!.n;
  if (Number(recognised) !== 1) {
    throw new SettlementJournalBlockedError('SETTLEMENT_JOURNAL_RECOGNITION_AMBIGUOUS', 'The posted invoice journal does not carry exactly one line on the mapped control account');
  }

  const bankLedger = await resolveBankLedgerAccount(client, companyId, row.bank_account_id, row.transaction_date, lock);
  if (!bankLedger) {
    throw new SettlementJournalBlockedError('SETTLEMENT_JOURNAL_BANK_UNLINKED', 'The bank account is not linked to an active bank ledger account on the transaction date');
  }
  const payable = row.direction === 'payable';
  return {
    settlementId, obligationId: row.obligation_id, accountingDate: row.transaction_date, amount: row.amount, direction: row.direction,
    bankAccountId: row.bank_account_id, bankLedgerAccountId: bankLedger, controlAccountId: control,
    debitAccountId: payable ? control : bankLedger, creditAccountId: payable ? bankLedger : control,
    description: `Obligation settlement: ${row.counterparty}`,
  };
}

/** The only blocks that leave a controlled MANUAL exception at posting: no approved treatment exists for them, so a reviewed manual journal (bank-line rule still enforced) is the only way. */
const MANUAL_EXCEPTION_CODES: ReadonlySet<SettlementJournalErrorCode> = new Set(['SETTLEMENT_JOURNAL_SOURCE_UNSUPPORTED', 'SETTLEMENT_JOURNAL_ADJUSTMENTS_EXIST']);

/**
 * Posting-time contract. An invoice-backed settlement journal must be exactly the two-line entry of its plan. It can never bypass that because a
 * mapping changed, the recognition became ambiguous, the bank link disappeared or the bank row no longer matches: those reject the posting with the
 * plan's own code. The manual exception is explicit and narrow: a non-invoice obligation (manual/opening/document sourced) or an invoice with credit/debit
 * notes, where no treatment is approved; the caller still enforces the bank-line rule for them.
 * Returns 'exact' or 'manual_exception'; throws SettlementJournalBlockedError otherwise.
 */
export async function verifyObligationSettlementJournal(client: PoolClient, companyId: string, journalId: string, settlementId: string): Promise<'exact' | 'manual_exception'> {
  let plan: SettlementJournalPlan;
  try { plan = await planObligationSettlementJournal(client, companyId, settlementId, true); }
  catch (error) {
    if (error instanceof SettlementJournalBlockedError && MANUAL_EXCEPTION_CODES.has(error.code)) return 'manual_exception';
    throw error;
  }
  const row = (await client.query<{ valid: boolean }>(
    `SELECT COUNT(*)=2 AND BOOL_AND((l.account_id=$2 AND l.debit=$4::numeric AND l.credit=0) OR (l.account_id=$3 AND l.credit=$4::numeric AND l.debit=0))
            AND COUNT(DISTINCT l.account_id)=2 valid
       FROM journal_lines l WHERE l.journal_entry_id=$1 AND l.company_id=$5`,
    [journalId, plan.debitAccountId, plan.creditAccountId, plan.amount, companyId])).rows[0];
  if (row?.valid !== true) {
    throw new SettlementJournalBlockedError('SETTLEMENT_JOURNAL_LINES_MISMATCH', 'Obligation settlement journal must debit the payable (or the bank for a receipt) and credit the bank (or the receivable) of the settled invoice obligation');
  }
  return 'exact';
}
