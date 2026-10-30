import { screen, waitFor, fireEvent } from './test-utils';
import { render } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from '../components/Home';
import { HomeAlertsProvider, actionableCount, type HomeAlert } from '../components/homeAlerts';
import { CompanyProvider } from '../context/CompanyContext';
import i18n from '../i18n';
import { MantineProvider } from '@mantine/core';

const alert = (key: string, ownership: HomeAlert['ownership'], count: number, extra: Partial<HomeAlert> = {}): HomeAlert => ({
  key, class: 'needs_review_completion', ownership, count, destination: 'documents', parameters: { status: 'needs_review' }, ...extra,
});
const navigateToDiscovery = vi.fn();

function renderHome(capabilities: string[], response: () => Promise<Response>) {
  const fetchMock = vi.fn((url: string) => (url === '/api/home-alerts' ? response() : Promise.resolve(new Response('{}', { status: 200 }))));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <HomeAlertsProvider capabilities={capabilities} companyId="co-1" onUnauthorized={vi.fn()}>
      <Home capabilities={capabilities} navigate={vi.fn()} navigateToDiscovery={navigateToDiscovery} onUnauthorized={vi.fn()} />
    </HomeAlertsProvider>,
  );
  return fetchMock;
}
const ok = (alerts: HomeAlert[]) => () => Promise.resolve(new Response(JSON.stringify({ as_of: '2026-10-30', alerts }), { status: 200 }));

describe('Home needs-attention section', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); vi.clearAllMocks(); });

  it('shows own items first, hides zero counts, and navigates with parameters', async () => {
    renderHome(['document.view'], ok([
      alert('documents_incomplete', 'waiting_for_team', 2, { parameters: { status: 'incomplete' } }),
      alert('documents_needs_review', 'current_user', 3),
      alert('documents_uploaded', 'current_user', 0, { parameters: { status: 'uploaded' } }),
    ]));
    const items = await screen.findAllByRole('button', { name: /documents/i });
    expect(items.map(i => i.getAttribute('data-alert-key'))).toEqual(['documents_needs_review', 'documents_incomplete']);
    expect(screen.queryByText('Uploaded documents awaiting review')).toBeNull();
    fireEvent.click(items[0]);
    expect(navigateToDiscovery).toHaveBeenCalledWith('documents', { status: 'needs_review' });
  });

  it('shows empty state when nothing needs attention', async () => {
    renderHome(['document.view'], ok([alert('documents_needs_review', 'current_user', 0)]));
    expect(await screen.findByText('Nothing needs your attention right now.')).toBeInTheDocument();
  });

  it('shows error state with retry', async () => {
    const fetchMock = renderHome(['document.view'], () => Promise.resolve(new Response('{}', { status: 500 })));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(c => c[0] === '/api/home-alerts').length).toBe(2));
  });

  it('makes no request and shows permission state without view capabilities', async () => {
    const fetchMock = renderHome(['fiscal_year.view'], ok([]));
    expect(await screen.findByText('You do not have permission to view action items.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/home-alerts', expect.anything());
  });

  it('renders Arabic labels with RTL', async () => {
    await i18n.changeLanguage('ar');
    renderHome(['document.view'], ok([alert('documents_needs_review', 'current_user', 1)]));
    expect(await screen.findByText('بانتظارك')).toBeInTheDocument();
    expect(screen.getByText('مستندات تحتاج مراجعة')).toBeInTheDocument();
  });
});

describe('actionableCount (bell)', () => {
  it('counts only the current user\'s actionable items', () => {
    expect(actionableCount([
      alert('documents_needs_review', 'current_user', 3),
      alert('documents_incomplete', 'waiting_for_team', 5),
      alert('upcoming_obligations', 'current_user', 4, { class: 'upcoming_due' }),
      alert('documents_uploaded', 'current_user', 0),
    ])).toBe(3);
  });
});

describe('notification bell', () => {
  it('shows a count only for the user\'s own actionable items', async () => {
    const { AppShell } = await import('../components/AppShell');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ alerts: [alert('documents_needs_review', 'current_user', 3), alert('documents_incomplete', 'waiting_for_team', 9)] }), { status: 200 }))));
    render(
      <MantineProvider><CompanyProvider allowedCompanies={[{ id: 'co-1', name: 'Company One' }]} initialCompanyId="co-1"><HomeAlertsProvider capabilities={['document.view']} companyId="co-1" onUnauthorized={vi.fn()}>
        <AppShell page="home" setPage={vi.fn()} capabilities={['document.view']} email="a@b.c" onSwitch={async () => true} onLogout={async () => {}}><div /></AppShell>
      </HomeAlertsProvider></CompanyProvider></MantineProvider>,
    );
    expect((await screen.findByTestId('bell-count')).textContent).toBe('3');
  });
});
