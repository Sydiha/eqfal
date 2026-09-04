import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyProvider } from '../context/CompanyContext';
import { Home } from '../components/Home';
import i18n from '../i18n';

const navigate = vi.fn();
const navigateToDiscovery = vi.fn();
const onUnauthorized = vi.fn();

function renderHome(capabilities: string[]) {
  return render(
    <CompanyProvider allowedCompanies={[{ id: 'co-1', name: 'Company One' }]} initialCompanyId="co-1">
      <Home
        capabilities={capabilities}
        navigate={navigate}
        navigateToDiscovery={navigateToDiscovery}
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

  it('does not load monthly close data without fiscal-year access', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHome(['document.view']);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Documents/ })).toBeInTheDocument();
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

  it('shows an error state instead of treating a failed API request as zero blockers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    renderHome(['fiscal_year.view']);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load or update monthly close.');
    expect(screen.queryByText('Blockers: 0')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
