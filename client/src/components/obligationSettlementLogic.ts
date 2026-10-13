/**
 * Advisory classification of bank transactions for one obligation settlement. The server remains the only authority
 * (direction, matching, reconciliation, period locks, single use, overpayment); this only explains why a row is not offered.
 */
export type SettlementBankTransaction = { id: string; transaction_date: string; description: string | null; bank_reference: string | null; amount: string; reconciliation_status: string };
export type IneligibleReason = 'alreadySettled' | 'notUnmatched' | 'wrongDirection' | 'exceedsOutstanding';
export type ClassifiedTransactions = { eligible: SettlementBankTransaction[]; ineligible: Array<{ transaction: SettlementBankTransaction; reason: IneligibleReason }> };

const toCents = (value: string): bigint => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(value.trim());
  if (!match) return 0n;
  const amount = BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0') || '0');
  return match[1] ? -amount : amount;
};

export function classifyBankTransactions(
  transactions: ReadonlyArray<SettlementBankTransaction>,
  context: { direction: 'receivable' | 'payable'; remainingAmount: string; usedTransactionIds: ReadonlySet<string> },
): ClassifiedTransactions {
  const remaining = toCents(context.remainingAmount);
  const result: ClassifiedTransactions = { eligible: [], ineligible: [] };
  for (const transaction of transactions) {
    const cents = toCents(transaction.amount);
    let reason: IneligibleReason | null = null;
    if (context.usedTransactionIds.has(transaction.id)) reason = 'alreadySettled';
    else if (transaction.reconciliation_status !== 'unmatched') reason = 'notUnmatched';
    else if (context.direction === 'receivable' ? cents <= 0n : cents >= 0n) reason = 'wrongDirection';
    else if ((cents < 0n ? -cents : cents) > remaining) reason = 'exceedsOutstanding';
    if (reason) result.ineligible.push({ transaction, reason });
    else result.eligible.push(transaction);
  }
  return result;
}

const SAFE_RETURN_KEY = /^(salesInv|purchaseInv)(Q|Status|Party|From|To|Page)$/;

/** Only the invoice workspace's own filter parameters survive a round trip; anything else in the URL is dropped. */
export function sanitizeReturnQuery(raw: string | null, page: 'sales' | 'purchases'): Record<string, string> {
  if (!raw || raw.length > 600) return {};
  const prefix = page === 'sales' ? 'salesInv' : 'purchaseInv';
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    if (SAFE_RETURN_KEY.test(key) && key.startsWith(prefix) && value.length <= 100) result[key] = value;
  }
  return result;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
