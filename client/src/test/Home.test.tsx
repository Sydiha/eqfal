import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyProvider } from '../context/CompanyContext';
import { Home } from '../components/Home';
import i18n from '../i18n';

const navigate = vi.fn();
const navigateToDiscovery = vi.fn();
const onUnauthorized = vi.fn();
const startPurchaseEntry = vi.fn();
const startSalesEntry = vi.fn();

function renderHome(capabilities: string[]) {
  return render(
    <CompanyProvider allowedCompanies={[{ id: 'co-1', name: 'Company One' }]} initialCompanyId="co-1">
      <Home capabilities={capabilities} navigate={navigate} navigateToDiscovery={navigateToDiscovery}
        startPurchaseEntry={startPurchaseEntry} startSalesEntry={startSalesEntry} onUnauthorized={onUnauthorized} />
    </CompanyProvider>,
  );
}

describe('Home — Financial Overview master', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
  });

  it('preserves capability-gated operational entry actions', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderHome(['document.upload', 'document.view', 'document.edit', 'obligation.view', 'bank.view']);
    screen.getByRole('button', { name: 'Add sale' }).click();
    screen.getByRole('button', { name: 'Add purchase' }).click();
    screen.getByRole('button', { name: 'Add expense' }).click();
    screen.getByRole('button', { name: 'Upload document' }).click();
    expect(startSalesEntry).toHaveBeenCalledOnce();
    expect(startPurchaseEntry).toHaveBeenNthCalledWith(1, 'purchase');
    expect(startPurchaseEntry).toHaveBeenNthCalledWith(2, 'expense');
    expect(navigate).toHaveBeenCalledWith('documents');
  });

  it('does not offer operational entry when a required capability is missing', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderHome(['document.upload', 'document.view', 'obligation.view']);
    expect(screen.queryByRole('button', { name: 'Add sale' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add purchase' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add expense' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload document' })).toBeInTheDocument();
  });

  it('does not fetch protected Home data without relevant capabilities', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHome([]);
    expect(screen.getByRole('heading', { name: 'Financial Overview' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders API-backed close blockers and preserves drill-through state', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/monthly-close-periods') return new Response(JSON.stringify({ periods: [{
        id: 'p1', fiscal_year_id: 'fy1', period_start: '2026-08-01', period_end: '2026-08-31',
        status: 'open', ready: false, disclosed_total: 3, has_hidden_blockers: false,
        blockers: { documents: 2, obligations: 1, bank_transactions: 0, vat: 0, ledger: 0 },
      }] }), { status: 200 });
      if (url === '/api/home-alerts') return new Response(JSON.stringify({ alerts: [] }), { status: 200 });
      if (url === '/api/manager-financial-snapshot') return new Response('', { status: 500 });
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHome(['monthly_close.view', 'document.view', 'obligation.view', 'bank.view', 'vat.view', 'accounting.view']);

    expect(await screen.findByRole('heading', { name: 'Monthly close readiness' })).toBeInTheDocument();
    const closeSection = screen.getByRole('heading', { name: 'Monthly close readiness' }).closest('section')!;
    const table = within(closeSection).getByRole('table');
    expect(within(table).getByText('Blockers: 2')).toBeInTheDocument();
    expect(within(table).getByText('Blockers: 1')).toBeInTheDocument();
    const documentRow = within(table).getByText('Documents').closest('tr')!;
    within(documentRow).getByRole('button', { name: 'Open' }).click();
    expect(navigateToDiscovery).toHaveBeenCalledWith('documents', { from: '2026-08-01', to: '2026-08-31' });
  });

  it('preserves safe hidden-blocker wording without leaking undisclosed totals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ periods: [{
      id: 'p1', fiscal_year_id: 'fy1', period_start: '2026-09-01', period_end: '2026-09-30',
      status: 'open', ready: false, disclosed_total: 2, has_hidden_blockers: true,
      blockers: { documents: 2, obligations: 0, bank_transactions: 0, vat: 0, ledger: 0, total: 99 },
    }] }), { status: 200 })));
    renderHome(['monthly_close.view', 'document.view']);
    await waitFor(() => expect(document.body).toHaveTextContent('There are blockers that require an authorized user.'));
    expect(document.body).not.toHaveTextContent('99');
    expect(document.body).not.toHaveTextContent('undefined');
  });

  it('renders capability-backed follow-up tasks and preserves drill-through parameters', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/home-alerts') return new Response(JSON.stringify({ alerts: [
        { key: 'overdue_obligations', class: 'needs_action_now', ownership: 'waiting_for_accountant', count: 2,
          destination: 'obligations', parameters: { overdue: '1' } },
      ] }), { status: 200 });
      if (url === '/api/manager-financial-snapshot') return new Response('', { status: 500 });
      return new Response('', { status: 404 });
    }));
    renderHome(['obligation.view']);
    expect(await screen.findByRole('heading', { name: 'Tasks requiring follow-up' })).toBeInTheDocument();
    const row = screen.getByText('Overdue obligations').closest('tr')!;
    expect(within(row).getAllByText('Waiting for accountant').length).toBeGreaterThan(0);
    expect(within(row).getByText('2')).toBeInTheDocument();
    within(row).getByRole('button', { name: 'Open' }).click();
    expect(navigateToDiscovery).toHaveBeenCalledWith('obligations', { overdue: '1' });
  });

  it('renders all follow-up ownership states in the master table', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/home-alerts') return new Response(JSON.stringify({ alerts: [
        { key: 'documents_needs_review', class: 'needs_review_completion', ownership: 'current_user', count: 2, destination: 'documents', parameters: {} },
        { key: 'upcoming_obligations', class: 'upcoming_due', ownership: 'upcoming', count: 1, destination: 'obligations', parameters: {} },
        { key: 'bank_transactions_unmatched', class: 'needs_review_completion', ownership: 'waiting_for_accountant', count: 3, destination: 'banks', parameters: {} },
      ] }), { status: 200 });
      if (url === '/api/manager-financial-snapshot') return new Response('', { status: 500 });
      return new Response('', { status: 404 });
    }));
    renderHome(['document.view', 'obligation.view', 'bank.view']);
    expect((await screen.findAllByText('Current user action')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Upcoming').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Waiting for accountant').length).toBeGreaterThan(0);
    expect(screen.queryByText('Waiting for team')).not.toBeInTheDocument();
  });

  it('renders snapshot values and explicit restricted states in the KPI strip', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/manager-financial-snapshot') return new Response(JSON.stringify({ metrics: {
        bank_balances: { state: 'available', accounts: [
          { id: 'b1', display_name: 'Operating account', currency_code: 'SAR', balance: { state: 'available', amount: '1250.50' } },
        ] },
        amounts_to_collect: { state: 'available', amount: '400.25' },
        amounts_to_pay: { state: 'available', amount: '90.00' },
        current_month_sales: { state: 'hidden' },
        current_month_purchases_expenses: { state: 'hidden' },
      } }), { status: 200 });
      if (url === '/api/home-alerts') return new Response(JSON.stringify({ alerts: [] }), { status: 200 });
      return new Response('', { status: 404 });
    }));
    renderHome(['bank.view', 'obligation.view']);
    expect(await screen.findByRole('heading', { name: 'Consolidated financial overview — current month' })).toBeInTheDocument();
    expect(await screen.findByText('1250.50 SAR')).toBeInTheDocument();
    expect(screen.getByText('400.25')).toBeInTheDocument();
    expect(screen.getByText('90.00')).toBeInTheDocument();
    expect(screen.getAllByText('Restricted by permissions')).toHaveLength(2);
  });
});
