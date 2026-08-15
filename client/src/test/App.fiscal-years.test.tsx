import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';
import i18n from '../i18n';

const session = (activeCompanyId: string) => ({ user: { id: 'u1', email: 'a@b.com' }, allowedCompanies: [{ id: 'co-a', name: 'Alpha', name_ar: null }, { id: 'co-b', name: 'Beta', name_ar: null }], activeCompanyId, capabilities: ['fiscal_year.view'] });

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('Fiscal year shell integration', () => {
  it('clears company data and refetches after a company switch', async () => {
    let resolveBeta!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session('co-a')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [{ id: 'a', name: 'Alpha FY', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(session('co-b')), { status: 200 }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveBeta = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthProvider><App/></AuthProvider>);
    expect(await screen.findByText('Alpha FY')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Switch active company'), { target: { value: 'co-b' } });
    await waitFor(() => expect(screen.queryByText('Alpha FY')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(/Switching company|Loading fiscal years/);
    resolveBeta(new Response(JSON.stringify({ fiscalYears: [{ id: 'b', name: 'Beta FY', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' }] }), { status: 200 }));
    expect(await screen.findByText('Beta FY')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(call => call[0] === '/api/fiscal-years')).toHaveLength(2);
  });

  it('returns to login when an application request receives 401', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session('co-a')), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 })));
    render(<AuthProvider><App/></AuthProvider>);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
