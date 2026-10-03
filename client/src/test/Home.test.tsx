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
      <Home
        capabilities={capabilities}
        navigate={navigate}
        navigateToDiscovery={navigateToDiscovery}
        startPurchaseEntry={startPurchaseEntry}
        startSalesEntry={startSalesEntry}
        onUnauthorized={onUnauthorized}
      />
    </CompanyProvider>,
  );
}

describe('Owner-approved Home financial overview', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
  });

  it('shows only authorized daily operations and opens their existing workflows', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderHome(['document.upload', 'document.view', 'document.edit', 'obligation.view', 'bank.view']);

    expect(screen.queryByRole('heading', { name: 'Daily Operations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add sale' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add purchase' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add expense' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload document' })).not.toBeInTheDocument();
  });


  it('does not offer operational entry when any required capability is missing', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderHome(['document.upload', 'document.view', 'obligation.view']);

    expect(screen.queryByRole('button', { name: 'Add sale' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add purchase' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add expense' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload document' })).not.toBeInTheDocument();
  });

  it('hides daily operations when their required capabilities are absent', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderHome([]);

    expect(screen.queryByRole('heading', { name: 'Daily Operations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add sale' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open obligations' })).not.toBeInTheDocument();
  });

  it('does not load monthly close data without monthly-close access', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ alerts: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderHome(['fiscal_year.view', 'document.view']);

    expect(fetchMock).not.toHaveBeenCalledWith('/api/monthly-close-periods', expect.anything());
    expect(screen.getByRole('heading', { name: 'Financial overview' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Workspaces' })).not.toBeInTheDocument();
    expect(screen.queryByText('Loading monthly close periods…')).not.toBeInTheDocument();
  });

  it('renders API-backed blocker categories and capability-aware drilldown actions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
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
    expect(await screen.findByRole('heading', { name: 'Close blockers' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Blockers: 2')).toBeInTheDocument();
    expect(within(table).getByText('Blockers: 1')).toBeInTheDocument();
    expect(within(table).getAllByText('No blockers')).toHaveLength(6);
    expect(within(table).getByText('Fixed Assets')).toBeInTheDocument();
    expect(within(table).getByText('Opening Balances')).toBeInTheDocument();
    expect(within(table).getByText('Periodic Adjustments')).toBeInTheDocument();
    expect(screen.getAllByText('Blockers: 3').length).toBeGreaterThan(0);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('undefined');

    within(table).getByRole('button', { name: 'Documents' }).click();
    expect(navigateToDiscovery).toHaveBeenCalledWith('documents', {
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });

  it('shows no blockers instead of ready-to-close wording for a closed period', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
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
      }), { status: 200 }),
    ));
    renderHome(['monthly_close.view']);

    expect(await screen.findByRole('heading', { name: 'No blockers' })).toBeInTheDocument();
    expect(screen.queryByText('Ready to close')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Workspaces' })).not.toBeInTheDocument();
  });

  it('uses safe non-numeric wording when undisclosed blockers exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      periods: [{
        id: 'p1', fiscal_year_id: 'fy1', period_start: '2026-09-01', period_end: '2026-09-30',
        status: 'open', ready: false, disclosed_total: 2, has_hidden_blockers: true,
        blockers: { documents: 2, obligations: 0, bank_transactions: 0, vat: 0, ledger: 0, assets: 0, opening_balances: 0, periodic_adjustments: 0, total: 99 },
      }],
    }), { status: 200 })));
    renderHome(['monthly_close.view', 'document.view']);

    expect(await screen.findByRole('heading', { name: 'There are blockers that require an authorized user.' })).toBeInTheDocument();
    expect(screen.getAllByText('There are blockers that require an authorized user.').length).toBeGreaterThan(1);
    expect(document.body).not.toHaveTextContent('99');
    expect(document.body).not.toHaveTextContent('undefined');
  });

  it('preserves ready wording for an open period that the backend marks ready', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      periods: [{
        id: 'p1', fiscal_year_id: 'fy1', period_start: '2026-09-01', period_end: '2026-09-30',
        status: 'open', ready: true, disclosed_total: 0, has_hidden_blockers: false,
        blockers: { documents: 0, obligations: 0, bank_transactions: 0, vat: 0, ledger: 0, assets: 0, opening_balances: 0, periodic_adjustments: 0 },
      }],
    }), { status: 200 })));
    renderHome(['monthly_close.view']);

    expect(await screen.findByRole('heading', { name: 'Ready to close' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('undefined');
  });

  it('shows an error state instead of treating a failed API request as zero blockers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    renderHome(['monthly_close.view']);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load or update monthly close.');
    expect(screen.queryByText('Blockers: 0')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders capability-backed alerts and preserves drill-through query state', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/home-alerts') return new Response(JSON.stringify({ alerts: [
        { key: 'overdue_obligations', class: 'needs_action_now', ownership: 'waiting_for_accountant', count: 2, destination: 'obligations', parameters: { overdue: '1' } },
      ] }), { status: 200 });
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHome(['obligation.view']);

    expect(await screen.findByRole('heading', { name: 'Work Queue' })).toBeInTheDocument();
    const alert = await screen.findByRole('button', { name: /Overdue obligations/ });
    expect(alert).toHaveTextContent('2');
    alert.click();
    expect(navigateToDiscovery).toHaveBeenCalledWith('obligations', { overdue: '1' });
  });

  it('groups alerts by backend ownership and omits empty ownership groups', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ alerts: [
      { key: 'documents_needs_review', class: 'needs_review_completion', ownership: 'current_user', count: 2, destination: 'documents', parameters: { status: 'needs_review' } },
      { key: 'upcoming_obligations', class: 'upcoming_due', ownership: 'upcoming', count: 1, destination: 'obligations', parameters: { dueFrom: '2026-09-17', dueTo: '2026-10-17' } },
      { key: 'bank_transactions_unmatched', class: 'needs_review_completion', ownership: 'waiting_for_accountant', count: 3, destination: 'banks', parameters: { section: 'transactions', reconciliation: 'unmatched' } },
    ] }), { status: 200 })));
    renderHome(['document.view', 'obligation.view', 'bank.view']);

    expect(await screen.findByRole('heading', { name: 'Work Queue' })).toBeInTheDocument();
    expect(screen.getByText('Current user action')).toBeInTheDocument();
    expect(screen.getAllByText('Upcoming').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Waiting for accountant').length).toBeGreaterThan(0);
    expect(screen.queryByText('Waiting for team')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Documents needing review/ })).toBeInTheDocument();
  });

  it('does not request or render alerts without a supported module view capability', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHome([]);
    expect(screen.queryByRole('heading', { name: 'Work Queue' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders available snapshot values and explicit unavailable and restricted states', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/manager-financial-snapshot') return new Response(JSON.stringify({ metrics: {
        bank_balances: { state: 'available', accounts: [
          { id: 'b1', display_name: 'Operating account', currency_code: 'SAR', balance: { state: 'available', amount: '1250.50' } },
          { id: 'b2', display_name: 'Reserve account', currency_code: 'USD', balance: { state: 'unavailable' } },
        ] },
        amounts_to_collect: { state: 'available', amount: '400.25' },
        amounts_to_pay: { state: 'available', amount: '90.00' },
        current_month_sales: { state: 'hidden' },
        current_month_purchases_expenses: { state: 'hidden' },
      } }), { status: 200 });
      if (url === '/api/home-alerts') return new Response(JSON.stringify({ alerts: [] }), { status: 200 });
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHome(['bank.view', 'obligation.view']);

    expect(await screen.findByRole('heading', { name: 'Manager Financial Snapshot' })).toBeInTheDocument();
    expect(await screen.findByText('Operating account')).toBeInTheDocument();
    expect(await screen.findByText('1,250.50 SAR')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('400.25 SAR')).toBeInTheDocument();
    expect(screen.getByText('90.00 SAR')).toBeInTheDocument();
    expect(screen.getAllByText('Restricted by permissions')).toHaveLength(2);
  });

  it('does not load or show the snapshot without any relevant view capability', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHome([]);

    expect(screen.queryByRole('heading', { name: 'Manager Financial Snapshot' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses one structure with true English LTR and Arabic RTL direction', async () => {
    vi.stubGlobal('fetch', vi.fn());
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
  });

  it('contains no persistent Home sidebar or fabricated financial indicators', () => {
    vi.stubGlobal('fetch', vi.fn());
    const { container } = renderHome([]);

    expect(container.querySelector('nav')).not.toBeInTheDocument();
    expect(container.querySelector('[class*="sidebar"]')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/net profit|gross margin|budget variance|cash-flow forecast|previous month|AI recommendation/i);
  });

  it('shows empty Work Queue and supports retry after an alerts error', async () => {
    let alertRequests = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/manager-financial-snapshot') {
        return new Response(JSON.stringify({ metrics: {
          bank_balances: { state: 'hidden' },
          amounts_to_collect: { state: 'hidden' },
          amounts_to_pay: { state: 'hidden' },
          current_month_sales: { state: 'hidden' },
          current_month_purchases_expenses: { state: 'hidden' },
        } }), { status: 200 });
      }
      alertRequests += 1;
      return alertRequests === 1
        ? new Response('', { status: 500 })
        : new Response(JSON.stringify({ alerts: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHome(['obligation.view']);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load alerts.');
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(await screen.findByRole('status')).toHaveTextContent('No outstanding actions.');
    expect(alertRequests).toBe(2);
  });

});
