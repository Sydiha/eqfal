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

const entry = (id: string, date: string, status: 'pending' | 'posted') => ({ id, period_start: date.slice(0, 8) + '01', period_end: date, recognition_date: date, amount: '10.00', status, journal_entry_id: status === 'posted' ? 'je' : null });
const quickItems = [
  adjustment('only-pending', '2026-01-01', '2026-03-31', [entry('a', '2026-03-31', 'pending')]),
  adjustment('only-posted', '2026-01-01', '2026-03-31', [entry('b', '2026-03-31', 'posted')]),
  adjustment('mixed', '2026-01-01', '2026-03-31', [entry('c', '2026-03-31', 'pending'), entry('d', '2026-02-28', 'posted')]),
  adjustment('pending-other-month', '2026-01-01', '2026-03-31', [entry('e', '2026-01-31', 'pending')]),
];
const mountQuick = (context: DateContextState) => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === '/api/periodic-adjustments') return new Response(JSON.stringify({ adjustments: quickItems }));
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts: [] }));
    if (url === '/api/documents') return new Response(JSON.stringify({ documents: [] }));
    if (url === '/api/obligations') return new Response(JSON.stringify({ obligations: [] }));
    throw Error(url);
  }));
  return render(<PeriodicAdjustments canView canCreate={false} canEdit={false} canSubmit={false} canReview={false} canApprove={false} canPost={false} onUnauthorized={vi.fn()} />, { dateContextValue: context });
};
const card = (name: RegExp) => screen.getByRole('button', { name });

describe('Periodic Adjustments KPI quick filters', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    window.history.replaceState(null, '', '/?page=periodicAdjustments');
  });

  it('filters by pending and posted periods inside the effective month scope, with active state and toggle back', async () => {
    mountQuick(ctx());
    await screen.findByText('only-pending');
    expect(card(/Total/)).toHaveAttribute('aria-pressed', 'true');
    expect(rows()).toHaveLength(4);
    fireEvent.click(card(/Pending/));
    expect(card(/Pending/)).toHaveAttribute('aria-pressed', 'true');
    expect(card(/Total/)).toHaveAttribute('aria-pressed', 'false');
    expect(rows().join('|')).toContain('only-pending');
    expect(rows().join('|')).toContain('mixed');
    expect(rows().join('|')).not.toContain('only-posted');
    expect(rows().join('|')).not.toContain('pending-other-month');
    fireEvent.click(card(/Posted/));
    // the mixed item's posted period (Feb) is outside March, so only the March-posted item matches
    expect(rows().join('|')).toContain('only-posted');
    expect(rows().join('|')).not.toContain('mixed');
    fireEvent.click(card(/Posted/));
    expect(rows()).toHaveLength(4);
    fireEvent.click(card(/Pending/));
    fireEvent.click(card(/Total/));
    expect(card(/Total/)).toHaveAttribute('aria-pressed', 'true');
    expect(rows()).toHaveLength(4);
  });

  it('uses the whole fiscal year in All-year mode and keeps the quick filter across a scope change', async () => {
    const Harness = () => {
      const [mode, setMode] = useState<'specific' | 'all'>('specific');
      return (
        <DateContext.Provider value={ctx(mode === 'all' ? { periodMode: 'all', selectedPeriodId: null } : {})}>
          <button onClick={() => setMode('all')}>all-year</button>
          <PeriodicAdjustments canView canCreate={false} canEdit={false} canSubmit={false} canReview={false} canApprove={false} canPost={false} onUnauthorized={vi.fn()} />
        </DateContext.Provider>
      );
    };
    cleanup();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/periodic-adjustments') return new Response(JSON.stringify({ adjustments: quickItems }));
      return new Response(JSON.stringify({ accounts: [], documents: [], obligations: [] }));
    }));
    render(<Harness />);
    await screen.findByText('only-pending');
    fireEvent.click(card(/Pending/));
    expect(rows().join('|')).not.toContain('pending-other-month');
    fireEvent.click(screen.getByText('all-year'));
    await waitFor(() => expect(rows().join('|')).toContain('pending-other-month'));
    expect(card(/Pending/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows Arabic card labels as keyboard-focusable buttons', async () => {
    await i18n.changeLanguage('ar');
    mountQuick(ctx());
    await screen.findByText('only-pending');
    const buttons = screen.getAllByRole('button').filter(b => b.classList.contains('pa-kpi'));
    expect(buttons).toHaveLength(3);
    buttons.forEach(b => expect(b.tagName).toBe('BUTTON'));
    expect(buttons[1]).toHaveTextContent(/فترات|معلق/);
  });
});
