import { describe, expect, it, vi } from 'vitest';
import { planObligationSettlementJournal } from '../src/modules/accounting/obligation-settlement-posting';

const baseRow = {
  amount: '9999999999999999.99', obligation_id: 'obligation', source_type: 'invoice', invoice_id: 'invoice', direction: 'payable' as const,
  verification_status: 'confirmed', is_cancelled: false, original_amount: '9999999999999999.99', bank_account_id: 'bank',
  bank_amount: '-9999999999999999.98', transaction_date: '2026-01-01', counterparty: 'Supplier', reference: null,
};

describe('obligation settlement exact amount comparison', () => {
  it('rejects a one-cent bank mismatch at the NUMERIC(18,2) limit', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [baseRow] })
      .mockResolvedValueOnce({ rows: [{ n: '0' }] });

    await expect(planObligationSettlementJournal({ query } as never, 'company', 'settlement', false))
      .rejects.toMatchObject({ code: 'SETTLEMENT_JOURNAL_BANK_MISMATCH' });
    expect(query).toHaveBeenCalledTimes(2);
  });
});
