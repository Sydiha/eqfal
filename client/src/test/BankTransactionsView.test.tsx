import { render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { BankTransactionsView } from '../components/BankTransactionsView';

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.restoreAllMocks();
});

describe('BankTransactionsView', () => {
  it('renders a focused five-column operating view with bank metadata kept secondary', async () => {
    const transaction = {
      id: '11111111-1111-4111-8111-111111111111',
      transaction_date: '2026-08-16T00:00:00.000Z',
      description: 'Vendor payment with mixed بيان عربي',
      bank_reference: 'BANK-REF-001',
      amount: '-350.00',
      running_balance: '12500.00',
      currency_code: 'SAR',
      reconciliation_status: 'unmatched',
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ transactions: [transaction] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<MantineProvider><BankTransactionsView canView canMatch canReconcile onUnauthorized={vi.fn()}/></MantineProvider>);

    expect(await screen.findByText('Vendor payment with mixed بيان عربي')).toBeInTheDocument();
    expect(screen.getByText('16/08/2026')).toBeInTheDocument();
    expect(screen.getByText('-350.00 SAR')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Match' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument();
    expect(screen.getByText('BANK-REF-001')).toBeInTheDocument();
    expect(screen.queryByText('12500.00 SAR')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/bank-transactions', undefined));
  });
});
