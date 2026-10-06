import { useState } from 'react';
import { fireEvent, screen, waitFor, within } from './test-utils';
import { render } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyProvider } from '../context/CompanyContext';
import { AuthProvider } from '../context/AuthContext';
import { Home } from '../components/Home';
import i18n from '../i18n';
import { DateContext, type DateContextState } from '../context/DateContext';

const navigate = vi.fn();
const navigateToDiscovery = vi.fn();
const onUnauthorized = vi.fn();

function renderHome(capabilities: string[], dateContextValue?: DateContextState) {
  return render(
    <AuthProvider>
      <CompanyProvider allowedCompanies={[{ id: 'co-1', name: 'Company One' }]} initialCompanyId="co-1">
        <Home
          capabilities={capabilities}
          navigate={navigate}
          navigateToDiscovery={navigateToDiscovery}
          onUnauthorized={onUnauthorized}
        />
      </CompanyProvider>
    </AuthProvider>,
    { dateContextValue },
  );
}

describe('Owner-approved Home financial overview', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
  });


  it('does not load monthly close data without monthly-close access', () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ alerts: [] }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHome(['fiscal_year.view', 'document.view']);

    expect(fetchMock).not.toHaveBeenCalledWith('/api/monthly-close-periods', expect.anything());
    expect(screen.getByRole('heading', { name: 'Financial overview' })).toBeInTheDocument();
  });

  it('renders API-backed blocker categories and capability-aware drilldown actions', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }), { status: 200 }));
      }
      if (url === '/api/monthly-close-periods') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              periods: [
                {
                  id: 'p1',
                  fiscal_year_id: 'fy1',
                  period_start: '2026-08-01',
                  period_end: '2026-08-31',
                  status: 'open',
                  ready: false,
                  disclosed_total: 3,
                  has_hidden_blockers: false,
                  blockers: {
                    documents: 2,
                    obligations: 1,
                    bank_transactions: 0,
                    vat: 0,
                    ledger: 0,
                    assets: 0,
                    opening_balances: 0,
                    periodic_adjustments: 0,
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderHome([
      'monthly_close.view',
      'document.view',
      'obligation.view',
      'bank.view',
      'vat.view',
      'accounting.view',
    ]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/monthly-close-periods', { credentials: 'same-origin' }));
    expect(await screen.findByRole('heading', { name: 'Monthly Close Readiness' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Documents')).toBeInTheDocument();
    expect(within(table).getByText('Obligations')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('undefined');

    const buttons = within(table).getAllByRole('button', { name: 'Handle' });
    buttons[0].click();
    expect(navigateToDiscovery).toHaveBeenCalledWith('documents', {
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });

  it('shows no blockers instead of ready-to-close wording for a closed period', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        periods: [
          {
            id: 'p1',
            fiscal_year_id: 'fy1',
            period_start: '2026-09-01',
            period_end: '2026-09-30',
            status: 'closed',
            ready: true,
            disclosed_total: 0,
            has_hidden_blockers: false,
            blockers: { documents: 0, obligations: 0, bank_transactions: 0, vat: 0, ledger: 0, assets: 0, opening_balances: 0, periodic_adjustments: 0 },
          },
        ],
      }), { status: 200 }));
    }));
    renderHome(['monthly_close.view']);

    expect(await screen.findByRole('heading', { name: 'Monthly Close Readiness' })).toBeInTheDocument();
    expect(screen.queryByText(/Close unavailable/)).not.toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('uses safe non-numeric wording when undisclosed blockers exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        periods: [{
          id: 'p1', fiscal_year_id: 'fy1', period_start: '2026-09-01', period_end: '2026-09-30',
          status: 'open', ready: false, disclosed_total: 2, has_hidden_blockers: true,
          blockers: { documents: 2, obligations: 0, bank_transactions: 0, vat: 0, ledger: 0, assets: 0, opening_balances: 0, periodic_adjustments: 0 },
        }],
      }), { status: 200 }));
    }));
    renderHome(['monthly_close.view', 'document.view']);

    expect(await screen.findByRole('heading', { name: 'Monthly Close Readiness' })).toBeInTheDocument();
    expect(screen.getByText(/Close unavailable/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('undefined');
  });

  it('preserves ready wording for an open period that the backend marks ready', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        periods: [{
          id: 'p1', fiscal_year_id: 'fy1', period_start: '2026-09-01', period_end: '2026-09-30',
          status: 'open', ready: true, disclosed_total: 0, has_hidden_blockers: false,
          blockers: { documents: 0, obligations: 0, bank_transactions: 0, vat: 0, ledger: 0, assets: 0, opening_balances: 0, periodic_adjustments: 0 },
        }],
      }), { status: 200 }));
    }));
    renderHome(['monthly_close.view']);

    expect(await screen.findByRole('heading', { name: 'Monthly Close Readiness' })).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('undefined');
  });

  it('shows an error state instead of treating a failed API request as zero blockers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response('', { status: 500 }));
    }));
    renderHome(['monthly_close.view']);

    expect(await screen.findByText('Unable to load data')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
  });


  it('does not request or render KPI section without a supported module view capability', () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHome([]);
    expect(screen.queryByText(/ر\.س/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/manager-financial-snapshot', expect.anything());
  });


  it('does not load or show the snapshot without any relevant view capability', () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHome([]);

    expect(screen.queryByText(/Cash and Banks/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/manager-financial-snapshot', expect.anything());
  });

  it('uses one structure with true English LTR and Arabic RTL direction', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }));
    const english = renderHome([]);
    const englishHome = english.container.querySelector('.eqfal-home');
    expect(englishHome).toHaveAttribute('dir', 'ltr');
    expect(englishHome).toHaveAttribute('data-language', 'en');
    expect(screen.getByRole('heading', { name: 'Financial overview' })).toBeInTheDocument();
    expect(english.container.querySelectorAll('.eqfal-home')).toHaveLength(1);

    english.unmount();
    await i18n.changeLanguage('ar');
    const arabic = renderHome([]);
    const arabicHome = arabic.container.querySelector('.eqfal-home');
    expect(arabicHome).toHaveAttribute('dir', 'rtl');
    expect(arabicHome).toHaveAttribute('data-language', 'ar');
    expect(screen.getByRole('heading', { name: 'نظرة عامة مالية' })).toBeInTheDocument();
    expect(arabic.container.querySelectorAll('.eqfal-home')).toHaveLength(1);
    expect(screen.getByText(/آخر تحديث:/)).toBeInTheDocument();
  });

  it('contains no persistent Home sidebar or fabricated financial indicators', () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }));
    const { container } = renderHome([]);

    expect(container.querySelector('nav')).not.toBeInTheDocument();
    expect(container.querySelector('[class*="sidebar"]')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/net profit|gross margin|budget variance|cash-flow forecast|previous month|AI recommendation/i);
  });



  it('requests the snapshot for the selected period and refetches when it changes', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/session') {
        return Promise.resolve(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ metrics: {} }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const base: DateContextState = {
      companyId: 'co-1', selectedFiscalYearId: 'fy-1', availableFiscalYears: [], selectedPeriodId: 'period-1',
      availablePeriodsForSelectedYear: [], periodMode: 'specific', isLoading: false, error: null,
      onSelectFiscalYear: async () => {}, onSelectPeriod: () => {}, loadFiscalYears: async () => {}, loadPeriodsForYear: async () => {},
    };
    function Harness() {
      const [periodId, setPeriodId] = useState('period-1');
      return (
        <DateContext.Provider value={{ ...base, selectedPeriodId: periodId }}>
          <button onClick={() => setPeriodId('period-2')}>switch</button>
          <AuthProvider>
            <CompanyProvider allowedCompanies={[{ id: 'co-1', name: 'Company One' }]} initialCompanyId="co-1">
              <Home capabilities={['document.view']} navigate={navigate} navigateToDiscovery={navigateToDiscovery} onUnauthorized={onUnauthorized} />
            </CompanyProvider>
          </AuthProvider>
        </DateContext.Provider>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/manager-financial-snapshot?period_id=period-1', expect.anything()));
    fireEvent.click(screen.getByText('switch'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/manager-financial-snapshot?period_id=period-2', expect.anything()));
  });
});
