import { screen, waitFor } from './test-utils';
import { render } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyProvider } from '../context/CompanyContext';
import { AuthProvider } from '../context/AuthContext';
import { Home } from '../components/Home';
import i18n from '../i18n';
import type { DateContextState } from '../context/DateContext';

const navigateToDiscovery = vi.fn();
const snapshot = {
  as_of: '2026-03-10',
  month: { start: '2026-03-01', end_exclusive: '2026-04-01' },
  metrics: {
    bank_balances: { state: 'available', accounts: [{ id: 'b', display_name: 'Main', currency_code: 'SAR', balance: { state: 'available', amount: '100' } }] },
    amounts_to_collect: { state: 'available', amount: '200' },
    amounts_to_pay: { state: 'available', amount: '300' },
    current_month_sales: { state: 'available', amount: '400' },
    current_month_purchases_expenses: { state: 'available', amount: '500' },
  },
};
const dateContext = (over: Partial<DateContextState> = {}): DateContextState => ({
  companyId: 'co-1',
  selectedFiscalYearId: 'fy',
  availableFiscalYears: [{ id: 'fy', company_id: 'co-1', name: '2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' }],
  selectedPeriodId: 'p-mar',
  availablePeriodsForSelectedYear: [
    { id: 'p-mar', fiscal_year_id: 'fy', period_start: '2026-03-01', period_end: '2026-03-31', status: 'open' },
    { id: 'month:2026-04', fiscal_year_id: 'fy', period_start: '2026-04-01', period_end: '2026-04-30', status: 'not_created' },
  ],
  periodMode: 'specific',
  isLoading: false,
  error: null,
  onSelectFiscalYear: async () => {},
  onSelectPeriod: () => {},
  loadFiscalYears: async () => {},
  loadPeriodsForYear: async () => {},
  ...over,
});
let fetchMock: ReturnType<typeof vi.fn>;
const renderHome = (capabilities: string[], ctx = dateContext()) => render(
  <AuthProvider><CompanyProvider allowedCompanies={[{ id: 'co-1', name: 'Co' }]} initialCompanyId="co-1">
    <Home capabilities={capabilities} navigate={vi.fn()} navigateToDiscovery={navigateToDiscovery} onUnauthorized={vi.fn()} />
  </CompanyProvider></AuthProvider>,
  { dateContextValue: ctx },
);
const ALL = ['bank.view', 'obligation.view', 'document.view'];

describe('Home KPI drill-down', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    navigateToDiscovery.mockClear();
    fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/manager-financial-snapshot')) return new Response(JSON.stringify(snapshot), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('opens each financial summary card with the narrowest supported scope', async () => {
    renderHome(ALL);
    const bank = await screen.findByRole('button', { name: /Cash and Banks/ });
    bank.click();
    screen.getByRole('button', { name: /Receivables/ }).click();
    screen.getByRole('button', { name: /Payables/ }).click();
    screen.getByRole('button', { name: /Revenue/ }).click();
    screen.getByRole('button', { name: /Expenses/ }).click();
    expect(navigateToDiscovery).toHaveBeenCalledWith('banks', { section: 'accounts' });
    expect(navigateToDiscovery).toHaveBeenCalledWith('obligations', { direction: 'receivable', confirmation: 'confirmed', scope: 'all' });
    expect(navigateToDiscovery).toHaveBeenCalledWith('obligations', { direction: 'payable', confirmation: 'confirmed', scope: 'all' });
    expect(navigateToDiscovery).toHaveBeenCalledWith('sales', { salesFrom: '2026-03-01', salesTo: '2026-03-31' });
    expect(navigateToDiscovery).toHaveBeenCalledWith('purchases', { purchaseFrom: '2026-03-01', purchaseTo: '2026-03-31' });
  });

  it('keeps Net Profit informational and uses the fiscal-year range in all-year mode', async () => {
    renderHome(ALL, dateContext({ periodMode: 'all', selectedPeriodId: null }));
    await screen.findByRole('button', { name: /Revenue/ });
    expect(screen.queryByRole('button', { name: /Net Profit/ })).not.toBeInTheDocument();
    screen.getByRole('button', { name: /Revenue/ }).click();
    expect(navigateToDiscovery).toHaveBeenCalledWith('sales', { salesFrom: '2026-01-01', salesTo: '2026-12-31' });
  });

  it('does not make cards actionable without the destination capability', async () => {
    renderHome(['bank.view']);
    expect(await screen.findByRole('button', { name: /Cash and Banks/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Receivables/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revenue/ })).not.toBeInTheDocument();
    expect(screen.getByText('Receivables')).toBeInTheDocument();
  });

  it('scopes the snapshot by calendar month for a month without a monthly-close record', async () => {
    renderHome([...ALL, 'monthly_close.view'], dateContext({ selectedPeriodId: 'month:2026-04' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/manager-financial-snapshot?month=2026-04&fiscal_year_id=fy', expect.anything()));
    expect(await screen.findByText(/No monthly close record exists for this month/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Monthly Close Readiness' })).not.toBeInTheDocument();
  });

  it('shows the selected period range and states each card\'s scope', async () => {
    renderHome(ALL);
    await screen.findByRole('button', { name: /Cash and Banks/ });
    const range = screen.getByTestId('home-period-range');
    expect(range).toHaveTextContent('2026');
    expect(screen.getAllByText('March 2026').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('All open balances')).toHaveLength(2);
  });

  it('keeps Net Profit as a non-clickable card without a scope caption', async () => {
    renderHome(ALL);
    await screen.findByRole('button', { name: /Cash and Banks/ });
    const card = screen.getByText('Net Profit').closest('.home__kpi-card')!;
    expect(card.tagName).toBe('DIV');
    expect(card.querySelector('.home__kpi-scope')).toBeNull();
  });

  it('uses the whole fiscal-year range in the subtitle in all-year mode', async () => {
    renderHome(ALL, dateContext({ periodMode: 'all', selectedPeriodId: null }));
    await screen.findByRole('button', { name: /Revenue/ });
    expect(screen.getByTestId('home-period-range')).toHaveTextContent(/2026.*2026/);
    expect(screen.getByText(/Aggregate Financial Summary – Full Year 2026/)).toBeInTheDocument();
  });

  it('renders the Arabic scope captions', async () => {
    await i18n.changeLanguage('ar');
    renderHome(ALL);
    await screen.findByRole('button', { name: /النقد والبنوك/ });
    expect(screen.getAllByText('كل الأرصدة المفتوحة')).toHaveLength(2);
  });
});
