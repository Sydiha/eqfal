import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';
import i18n from '../i18n';

const session = (activeCompanyId: string) => ({ user: { id: 'u1', email: 'a@b.com' }, allowedCompanies: [{ id: 'co-a', name: 'Alpha', name_ar: null }, { id: 'co-b', name: 'Beta', name_ar: null }], activeCompanyId, capabilities: ['fiscal_year.view'] });
const emptyPeriods = () => new Response(JSON.stringify({ periods: [] }), { status: 200 });

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('Fiscal year shell integration', () => {
  it('clears company data and refetches after a company switch', async () => {
    let activeCompanyId = 'co-a';
    let fiscalRequestCount = 0;
    let resolveBeta!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/session') return Promise.resolve(new Response(JSON.stringify(session(activeCompanyId)), { status: 200 }));
      if (url === '/api/monthly-close-periods') return Promise.resolve(emptyPeriods());
      if (url === '/api/auth/switch-company') {
        activeCompanyId = 'co-b';
        return Promise.resolve(new Response(JSON.stringify(session(activeCompanyId)), { status: 200 }));
      }
      if (url === '/api/fiscal-years') {
        fiscalRequestCount += 1;
        if (fiscalRequestCount === 1) return Promise.resolve(new Response(JSON.stringify({ fiscalYears: [{ id: 'a', name: 'Alpha FY', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' }] }), { status: 200 }));
        return new Promise<Response>(resolve => { resolveBeta = resolve; });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthProvider><App/></AuthProvider>);
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: 'Fiscal Years' }));
    expect(await screen.findByText('Alpha FY')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Switch active company'), { target: { value: 'co-b' } });
    await waitFor(() => expect(screen.queryByText('Alpha FY')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(/Switching company|Loading fiscal years/);
    resolveBeta(new Response(JSON.stringify({ fiscalYears: [{ id: 'b', name: 'Beta FY', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' }] }), { status: 200 }));
    expect(await screen.findByText('Beta FY')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(call => call[0] === '/api/fiscal-years')).toHaveLength(2);
  });

  it('returns to login when an application request receives 401', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/session') return Promise.resolve(new Response(JSON.stringify(session('co-a')), { status: 200 }));
      if (url === '/api/monthly-close-periods') return Promise.resolve(emptyPeriods());
      if (url === '/api/fiscal-years') return Promise.resolve(new Response(null, { status: 401 }));
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthProvider><App/></AuthProvider>);
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: 'Fiscal Years' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
