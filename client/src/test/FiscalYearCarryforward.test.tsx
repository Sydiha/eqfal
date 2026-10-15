import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FiscalYearCarryforward } from '../components/FiscalYearCarryforward';
import i18n from '../i18n';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const year = { id: 'y1', name: 'FY25', start_date: '2025-01-01', end_date: '2025-12-31', status: 'closed' as const };
const accounts = { accounts: [{ id: 're', code: '3100', name: 'RE', account_type: 'equity', statement_category: 'equity', is_active: true }, { id: 'b', code: '1000', name: 'Bank', account_type: 'asset', statement_category: 'current_asset', is_active: true }] };
const blocked = { to_year: null, ready: false, net_result: '0.00', total_debit: '0.00', total_credit: '0.00', blockers: [{ code: 'NEXT_FISCAL_YEAR_MISSING' }], lines: [], existing: null };
const ready = { ...blocked, to_year: { name: 'FY26' }, ready: true, net_result: '3000.00', total_debit: '10.00', total_credit: '10.00', blockers: [], lines: [{ account_id: 'b', code: '1000', name: 'Bank', side: 'debit', amount: '10.00' }] };

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });
afterEach(() => cleanup());

describe('FiscalYearCarryforward', () => {
  it('shows blockers in plain words and keeps prepare disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/accounts' ? json(accounts) : json(blocked)));
    render(<FiscalYearCarryforward year={year} onClose={vi.fn()} onUnauthorized={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Create the next fiscal year first');
    expect(screen.getByRole('button', { name: 'Prepare opening balance' })).toBeDisabled();
    expect(screen.queryByRole('option', { name: /Bank/ })).toBeNull(); // only equity accounts are offered
  });

  it('previews, then POSTs the chosen retained-earnings account only after the click', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => url === '/api/accounts' ? json(accounts) : init?.method === 'POST' ? json({}, 201) : json(ready));
    vi.stubGlobal('fetch', fetchMock);
    render(<FiscalYearCarryforward year={year} onClose={vi.fn()} onUnauthorized={vi.fn()} />);
    await screen.findByRole('option', { name: /3100/ });
    fireEvent.change(screen.getByLabelText('Retained-earnings account'), { target: { value: 're' } });
    await screen.findByText(/3000.00/);
    expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare opening balance' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('draft opening balance'));
    expect(fetchMock).toHaveBeenCalledWith('/api/fiscal-years/y1/carryforward', expect.objectContaining({ method: 'POST', body: JSON.stringify({ retained_earnings_account_id: 're' }) }));
  });
});
