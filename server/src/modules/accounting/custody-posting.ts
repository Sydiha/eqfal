import { PoolClient } from 'pg';
import { resolveBankLedgerAccount } from './personal-payment-posting';
import { toCents } from '../banking/bank-reconciliation-core';
import { JournalPostingValidationError } from './journal-posting-errors';
import type { OperationalSource } from './operational-sources';

/**
 * Accounting contract of employee custody advances (D4/Q5, Owner policy 2026-10-27). The custody ledger account is a CURRENT ASSET configured explicitly
 * per company (custody_account_mappings); it is never inferred. Funding is not an expense.
 *
 *   custody_funding    : Dr custody account / Cr company bank ledger account   (exactly two lines, the bank amount)
 *   custody_allocation : Dr the expense side (any other debit lines, VAT included) / Cr custody account only, for exactly the allocation amount
 *   custody_return     : Dr company bank ledger account / Cr custody account   (exactly two lines)
 * Enforced only when a journal is POSTED; journals already posted are never re-checked or modified.
 */
type Runner = Pick<PoolClient, 'query'>;

export const CUSTODY_SOURCE_TYPES = ['custody_funding', 'custody_allocation', 'custody_return'] as const;
export const isCustodySourceType = (v: unknown): v is (typeof CUSTODY_SOURCE_TYPES)[number] =>
  typeof v === 'string' && (CUSTODY_SOURCE_TYPES as readonly string[]).includes(v);

/** The configured custody account when it is still valid (active asset classified as current asset), else null. Share-locks mapping and account when lock=true. */
export async function resolveCustodyLedgerAccount(client: Runner, companyId: string, lock: boolean): Promise<string | null> {
  const row = (await client.query<{ account_id: string }>(
    `SELECT m.account_id FROM custody_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id
      WHERE m.company_id=$1 AND a.is_active AND a.account_type='asset' AND a.statement_category='current_asset'${lock ? ' FOR SHARE OF m, a' : ''}`, [companyId])).rows[0];
  return row?.account_id ?? null;
}

const fail = (message: string) => new JournalPostingValidationError(message);

export async function assertCustodyJournalControls(client: Runner, companyId: string, journalId: string, source: OperationalSource): Promise<void> {
  if (!isCustodySourceType(source.source_type)) return;
  const custodyAccount = await resolveCustodyLedgerAccount(client, companyId, true);
  if (!custodyAccount) throw fail('Custody ledger account is not configured, inactive, or not an active current-asset account');
  const lines = (await client.query<{ account_id: string; debit: string; credit: string; n: string }>(
    `SELECT account_id, SUM(debit)::numeric(18,2)::text debit, SUM(credit)::numeric(18,2)::text credit, COUNT(*)::text n
       FROM journal_lines WHERE journal_entry_id=$1 AND company_id=$2 GROUP BY account_id`, [journalId, companyId])).rows;
  const amount = toCents(source.amount);
  const zero = (v: string) => toCents(v) === 0n;
  const is = (v: string, n: bigint) => toCents(v) === n;
  const custody = lines.find((l) => l.account_id === custodyAccount);
  if (source.source_type === 'custody_allocation') {
    if (!custody || !zero(custody.debit) || !is(custody.credit, amount)) {
      throw fail('Custody allocation journal must credit the custody ledger account by exactly the allocation amount');
    }
    if (lines.some((l) => l.account_id !== custodyAccount && !zero(l.credit))) {
      throw fail('Custody allocation journal may only debit the expense side and credit the custody ledger account');
    }
    return;
  }
  const bankAccountId = source.context?.['bank_account_id'];
  if (typeof bankAccountId !== 'string') throw fail('Custody bank account cannot be determined');
  const bankLedger = await resolveBankLedgerAccount(client, companyId, bankAccountId, source.accounting_date, true);
  if (!bankLedger) throw fail('Custody bank account is not linked to an active bank ledger account on the transaction date');
  if (bankLedger === custodyAccount) throw fail('The custody ledger account must differ from the bank ledger account');
  const funding = source.source_type === 'custody_funding';
  const bank = lines.find((l) => l.account_id === bankLedger);
  const exact = lines.length === 2 && !!custody && !!bank && custody.n === '1' && bank.n === '1'
    && (funding
      ? is(custody.debit, amount) && zero(custody.credit) && is(bank.credit, amount) && zero(bank.debit)
      : is(custody.credit, amount) && zero(custody.debit) && is(bank.debit, amount) && zero(bank.credit));
  if (!exact) {
    throw fail(funding
      ? 'Custody funding journal must debit the custody ledger account and credit the linked bank ledger account by exactly the funded amount'
      : 'Custody return journal must debit the linked bank ledger account and credit the custody ledger account by exactly the returned amount');
  }
}
