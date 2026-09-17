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

describe('Home v2.1', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
  });

  it('shows only authorized daily operations and opens their existing workflows', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderHome(['document.upload', 'document.view', 'obligation.view', 'bank.view']);

    expect(screen.getByRole('heading', { name: 'Daily Operations' })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Add sale' }).click();
    screen.getByRole('button', { name: 'Add purchase' }).click();
    screen.getByRole('button', { name: 'Add expense' }).click();
    screen.getByRole('button', { name: 'Upload document' }).click();
    screen.getByRole('button', { name: 'Open sales' }).click();
    screen.getByRole('button', { name: 'Open banking' }).click();

    expect(startSalesEntry).toHaveBeenCalledOnce();
    expect(startPurchaseEntry).toHaveBeenNthCalledWith(1, 'purchase');
    expect(startPurchaseEntry).toHaveBeenNthCalledWith(2, 'expense');
    expect(navigate).toHaveBeenCalledWith('documents');
    expect(navigate).toHaveBeenCalledWith('sales');
    expect(navigate).toHaveBeenCalledWith('banks');
  });

  it('hides daily operations when their required capabilities are absent', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderHome([]);

    expect(screen.queryByRole('heading', { name: 'Daily Operations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add sale' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open obligations' })).not.toBeInTheDocument();
  });

  it('does not load monthly close data without fiscal-year access', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHome(['document.view']);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
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
              blockers: {
                documents: 2,
                obligations: 1,
                bank_transactions: 0,
                vat: 0,
                ledger: 0,
                total: 3,
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderHome([
      'fiscal_year.view',
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
    expect(within(table).getAllByText('No blockers')).toHaveLength(3);

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
            blockers: { documents: 0, obligations: 0, bank_transactions: 0, vat: 0, ledger: 0, total: 0 },
          },
        ],
      }), { status: 200 }),
    ));
    renderHome(['fiscal_year.view']);

    expect(await screen.findByRole('heading', { name: 'No blockers' })).toBeInTheDocument();
    expect(screen.queryByText('Ready to close')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Workspaces' })).not.toBeInTheDocument();
  });

  it('shows an error state instead of treating a failed API request as zero blockers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    renderHome(['fiscal_year.view']);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load or update monthly close.');
    expect(screen.queryByText('Blockers: 0')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
