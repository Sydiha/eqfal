import { act, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';

vi.mock('../components/BankTransactionsView', () => ({ BankTransactionsView: () => <div>transactions-content</div> }));
vi.mock('../components/Banking', () => ({ Banking: () => <div>core-content</div> }));
vi.mock('../components/SettlementPanel', () => ({ SettlementPanel: () => <div>settlements-content</div> }));
vi.mock('../components/CustodyPanel', () => ({ CustodyPanel: () => <div>custody-content</div> }));

import { BankingWorkspace } from '../components/BankingWorkspace';

const props = { canView: true, canImport: true, canManage: true, canMatch: true, canReconcile: true, canSettle: true, canViewCustody: true, canManageCustody: true, canCloseCustody: true, onUnauthorized: vi.fn() };

describe('BankingWorkspace section query state', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    window.history.replaceState(null, '', '/?page=banks&section=transactions');
  });

  it('restores transactions from a deep link and writes section changes', () => {
    render(<MantineProvider><BankingWorkspace {...props}/></MantineProvider>);
    expect(screen.getByText('transactions-content')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Accounts' }));
    expect(screen.getByText('core-content')).toBeInTheDocument();
    expect(window.location.search).toBe('?page=banks&section=accounts');
  });

  it('restores back/forward section changes and safely falls back for invalid sections', () => {
    const { unmount } = render(<MantineProvider><BankingWorkspace {...props}/></MantineProvider>);
    act(() => { window.history.pushState(null, '', '/?page=banks&section=settlements'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(screen.getByText('settlements-content')).toBeInTheDocument();
    act(() => { window.history.pushState(null, '', '/?page=banks&section=transactions'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(screen.getByText('transactions-content')).toBeInTheDocument();
    unmount();
    window.history.replaceState(null, '', '/?page=banks&section=unknown');
    render(<MantineProvider><BankingWorkspace {...props}/></MantineProvider>);
    expect(screen.getByText('transactions-content')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Transactions' })).toHaveAttribute('aria-selected', 'true');
  });
});
