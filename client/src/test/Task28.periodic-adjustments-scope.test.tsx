import { useState } from 'react';
import { cleanup, fireEvent, screen, waitFor } from './test-utils';
import { render } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { PeriodicAdjustments } from '../components/PeriodicAdjustments';
import { DateContext, type DateContextState } from '../context/DateContext';

const adjustment = (id: string, start: string, end: string, schedule: unknown[] = []) => ({
  id, adjustment_type: 'accrued_expense', total_amount: '100.00', recognition_start: start, recognition_end: end,
  document_id: null, obligation_id: null, document_name: null, description: id, reference: null, notes: null,
  balance_account_id: 'a', pnl_account_id: 'b', workflow_status: 'draft', review_note: null, version: 1, schedule,
});
const items = [
  adjustment('jan-item', '2026-01-01', '2026-01-31'),
  adjustment('mar-item', '2026-03-01', '2026-03-31'),
  adjustment('q1-item', '2026-01-01', '2026-03-31'),
  adjustment('prior-year-item', '2025-01-01', '2025-12-31'),
];
const ctx = (over: Partial<DateContextState> = {}): DateContextState => ({
  companyId: 'co', selectedFiscalYearId: 'fy',
  availableFiscalYears: [{ id: 'fy', company_id: 'co', name: '2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' }],
  selectedPeriodId: 'month:2026-03',
  availablePeriodsForSelectedYear: [
    { id: 'month:2026-01', fiscal_year_id: 'fy', period_start: '2026-01-01', period_end: '2026-01-31', status: 'not_created' },
    { id: 'month:2026-03', fiscal_year_id: 'fy', period_start: '2026-03-01', period_end: '2026-03-31', status: 'not_created' },
  ],
  periodMode: 'specific', isLoading: false, error: null,
  onSelectFiscalYear: async () => {}, onSelectPeriod: () => {}, loadFiscalYears: async () => {}, loadPeriodsForYear: async () => {},
  ...over,
});
const mount = (context: DateContextState) => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/periodic-adjustments') return new Response(JSON.stringify({ adjustments: items }));
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts: [] }));
    if (url === '/api/documents') return new Response(JSON.stringify({ documents: [] }));
    if (url === '/api/obligations') return new Response(JSON.stringify({ obligations: [] }));
    throw Error(url);
  }));
  const props = { canView: true, canCreate: false, canEdit: false, canSubmit: false, canReview: false, canApprove: false, canPost: false, onUnauthorized: vi.fn() };
  const view = render(<PeriodicAdjustments {...props} />, { dateContextValue: context });
  return { ...view, props };
};
const rows = () => screen.getAllByRole('row').slice(1).map(r => r.textContent ?? '');

describe('Periodic Adjustments global month scope', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    window.history.replaceState(null, '', '/?page=periodicAdjustments');
  });

  it('shows only adjustments overlapping the selected month', async () => {
    mount(ctx());
    await screen.findByText('mar-item');
    const text = rows().join('|');
    expect(text).toContain('mar-item');
    expect(text).toContain('q1-item');
    expect(text).not.toContain('jan-item');
    expect(text).not.toContain('prior-year-item');
    expect(screen.getByText('2 adjustments')).toBeInTheDocument();
  });

  it('All year shows the whole fiscal year and still excludes other years', async () => {
    mount(ctx({ periodMode: 'all', selectedPeriodId: null }));
    await screen.findByText('mar-item');
    const text = rows().join('|');
    expect(text).toContain('jan-item');
    expect(text).toContain('q1-item');
    expect(text).not.toContain('prior-year-item');
    expect(screen.getByText('3 adjustments')).toBeInTheDocument();
  });

  it('does not scope until the global period is known', async () => {
    mount(ctx({ selectedPeriodId: null, availablePeriodsForSelectedYear: [] }));
    await screen.findByText('prior-year-item');
    expect(screen.getByText('4 adjustments')).toBeInTheDocument();
  });

  it('drops a stale drill-down range when the global month changes', async () => {
    window.history.replaceState(null, '', '/?page=periodicAdjustments&adjustmentFrom=2026-03-01&adjustmentTo=2026-03-31');
    mount(ctx());
    await screen.findByText('mar-item');
    expect(window.location.search).toContain('adjustmentFrom');
    expect(screen.queryByText('jan-item')).not.toBeInTheDocument();

    const Harness = () => {
      const [period, setPeriod] = useState('month:2026-03');
      return (
        <DateContext.Provider value={ctx({ selectedPeriodId: period })}>
          <button onClick={() => setPeriod('month:2026-01')}>switch</button>
          <PeriodicAdjustments canView canCreate={false} canEdit={false} canSubmit={false} canReview={false} canApprove={false} canPost={false} onUnauthorized={vi.fn()} />
        </DateContext.Provider>
      );
    };
    cleanup();
    window.history.replaceState(null, '', '/?page=periodicAdjustments&adjustmentFrom=2026-03-01&adjustmentTo=2026-03-31');
    render(<Harness />);
    await screen.findByText('mar-item');
    fireEvent.click(screen.getByText('switch'));
    await waitFor(() => expect(window.location.search).not.toContain('adjustmentFrom'));
    expect(await screen.findByText('jan-item')).toBeInTheDocument();
    expect(screen.queryByText('mar-item')).not.toBeInTheDocument();
  });
});
