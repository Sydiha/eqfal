import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DateContextProvider, useDateContext } from '../DateContext';

// Mock fetch
global.fetch = vi.fn();

const mockFiscalYears = [
  {
    id: 'fy-2026',
    company_id: 'company-1',
    name: '2026 FY',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    status: 'active'
  }
];

const mockPeriods = [
  {
    id: 'period-july-2026',
    fiscal_year_id: 'fy-2026',
    period_start: '2026-07-01',
    period_end: '2026-07-31',
    status: 'open'
  }
];

describe('DateContext', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockFiscalYears
    });
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockPeriods
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('initializes with default fiscal year containing today', async () => {
    const TestComponent = () => {
      const { selectedFiscalYearId } = useDateContext();
      return <div>{selectedFiscalYearId}</div>;
    };

    render(
      <DateContextProvider companyId="company-1">
        <TestComponent />
      </DateContextProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('fy-2026')).toBeInTheDocument();
    });
  });

  it('respects persisted fiscal year selection', async () => {
    localStorage.setItem('eqfal_selectedFiscalYearId_company-1', 'fy-2026');

    const TestComponent = () => {
      const { selectedFiscalYearId } = useDateContext();
      return <div>{selectedFiscalYearId}</div>;
    };

    render(
      <DateContextProvider companyId="company-1">
        <TestComponent />
      </DateContextProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('fy-2026')).toBeInTheDocument();
    });
  });

  it('stores selected period in company-scoped localStorage', async () => {
    const TestComponent = () => {
      const { onSelectPeriod } = useDateContext();
      return (
        <button onClick={() => onSelectPeriod('period-july-2026', 'specific')}>
          Select Period
        </button>
      );
    };

    render(
      <DateContextProvider companyId="company-1">
        <TestComponent />
      </DateContextProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Select Period')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Select Period'));

    await waitFor(() => {
      expect(localStorage.getItem('eqfal_selectedPeriodId_company-1')).toBe('period-july-2026');
    });
  });

  it('provides available fiscal years', async () => {
    const TestComponent = () => {
      const { availableFiscalYears } = useDateContext();
      return (
        <div>
          {availableFiscalYears.map(y => (
            <span key={y.id}>{y.name}</span>
          ))}
        </div>
      );
    };

    render(
      <DateContextProvider companyId="company-1">
        <TestComponent />
      </DateContextProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('2026 FY')).toBeInTheDocument();
    });
  });

  it('provides available periods for selected year', async () => {
    const TestComponent = () => {
      const { availablePeriodsForSelectedYear } = useDateContext();
      return (
        <div>
          {availablePeriodsForSelectedYear.map(p => (
            <span key={p.id}>{p.id}</span>
          ))}
        </div>
      );
    };

    render(
      <DateContextProvider companyId="company-1">
        <TestComponent />
      </DateContextProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('period-july-2026')).toBeInTheDocument();
    });
  });

  it('throws error when used outside provider', () => {
    const TestComponent = () => {
      useDateContext();
      return <div>Test</div>;
    };

    // Suppress console.error for this test
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      render(<TestComponent />);
    }).toThrow('useDateContext must be used within DateContextProvider');

    consoleErrorSpy.mockRestore();
  });

  it('handles switching period mode to all', async () => {
    const TestComponent = () => {
      const { onSelectPeriod, periodMode } = useDateContext();
      return (
        <>
          <div>{periodMode}</div>
          <button onClick={() => onSelectPeriod('', 'all')}>
            Select All
          </button>
        </>
      );
    };

    render(
      <DateContextProvider companyId="company-1">
        <TestComponent />
      </DateContextProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('specific')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Select All'));

    await waitFor(() => {
      expect(screen.getByText('all')).toBeInTheDocument();
    });

    expect(localStorage.getItem('eqfal_periodMode_company-1')).toBe('all');
  });

  it('uses company-scoped localStorage keys', async () => {
    const TestComponent = () => {
      const { onSelectPeriod } = useDateContext();
      return (
        <button onClick={() => onSelectPeriod('period-july-2026', 'specific')}>
          Select
        </button>
      );
    };

    render(
      <DateContextProvider companyId="company-1">
        <TestComponent />
      </DateContextProvider>
    );

    fireEvent.click(screen.getByText('Select'));

    // Verify company-1 has the value
    expect(localStorage.getItem('eqfal_selectedPeriodId_company-1')).toBe('period-july-2026');

    // Verify company-2 does not have this value (isolated storage)
    expect(localStorage.getItem('eqfal_selectedPeriodId_company-2')).toBeNull();
  });
});

describe('DateContext full-year months', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    (global.fetch as any).mockResolvedValueOnce({ ok: true, json: async () => mockFiscalYears });
    (global.fetch as any).mockResolvedValueOnce({ ok: true, json: async () => mockPeriods });
  });

  it('lists January-December although only one monthly-close record exists, keeping the real period selected by default', async () => {
    const TestComponent = () => {
      const { availablePeriodsForSelectedYear, selectedPeriodId, onSelectPeriod, periodMode } = useDateContext();
      return (
        <div>
          <span data-testid="count">{availablePeriodsForSelectedYear.length}</span>
          <span data-testid="selected">{periodMode === 'all' ? 'all' : selectedPeriodId}</span>
          <span data-testid="ids">{availablePeriodsForSelectedYear.map(p => p.id).join(',')}</span>
          <button onClick={() => onSelectPeriod('month:2026-02', 'specific')}>feb</button>
          <button onClick={() => onSelectPeriod('', 'all')}>all</button>
        </div>
      );
    };
    render(<DateContextProvider companyId="company-1"><TestComponent /></DateContextProvider>);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('12'));
    expect(screen.getByTestId('ids').textContent).toContain('month:2026-01');
    expect(screen.getByTestId('ids').textContent).toContain('period-july-2026');
    expect(screen.getByTestId('ids').textContent).not.toContain('month:2026-07');
    await waitFor(() => expect(screen.getByTestId('selected')).toHaveTextContent('period-july-2026'));

    fireEvent.click(screen.getByText('feb'));
    expect(screen.getByTestId('selected')).toHaveTextContent('month:2026-02');
    fireEvent.click(screen.getByText('all'));
    expect(screen.getByTestId('selected')).toHaveTextContent('all');
    expect(screen.getByTestId('count')).toHaveTextContent('12');
  });
});

describe('DateContext fiscal-year request ordering', () => {
  it('moves from FY 2026 to FY 2027 with the new year\'s period context', async () => {
    localStorage.clear();
    const years = [
      { ...mockFiscalYears[0], id: 'fy-2026', name: 'FY 2026' },
      { ...mockFiscalYears[0], id: 'fy-2027', name: 'FY 2027', start_date: '2027-01-01', end_date: '2027-12-31' },
    ];
    let requestIndex = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      requestIndex++;
      if (requestIndex === 1) return Promise.resolve(new Response(JSON.stringify(years)));
      if (requestIndex === 2) return Promise.resolve(new Response(JSON.stringify([{ ...mockPeriods[0], fiscal_year_id: 'fy-2026' }])));
      if (requestIndex === 3) return Promise.resolve(new Response(JSON.stringify([{ id: 'period-2027', fiscal_year_id: 'fy-2027', period_start: '2027-11-01', period_end: '2027-11-30', status: 'open' }])));
      throw new Error(`Unexpected request ${requestIndex}`);
    }));
    const Probe = () => {
      const { selectedFiscalYearId, selectedPeriodId, onSelectFiscalYear } = useDateContext();
      return <><span data-testid="year">{selectedFiscalYearId}</span><span data-testid="period">{selectedPeriodId}</span><button onClick={() => void onSelectFiscalYear('fy-2027')}>Switch to FY 2027</button></>;
    };
    render(<DateContextProvider companyId="company-1"><Probe /></DateContextProvider>);
    await waitFor(() => expect(screen.getByTestId('year')).toHaveTextContent('fy-2026'));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to FY 2027' }));
    await waitFor(() => expect(screen.getByTestId('period')).toHaveTextContent('period-2027'));
    expect(screen.getByTestId('year')).toHaveTextContent('fy-2027');
  });

  it('keeps the latest FY selection and periods when requests resolve out of order', async () => {
    localStorage.clear();
    const years = [
      { ...mockFiscalYears[0], id: 'fy-2026', name: 'FY 2026' },
      { ...mockFiscalYears[0], id: 'fy-2027', name: 'FY 2027', start_date: '2027-01-01', end_date: '2027-12-31' },
    ];
    let requestIndex = 0;
    let resolveOld!: (response: Response) => void;
    let resolveLatest!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => {
      requestIndex++;
      if (requestIndex === 1) return Promise.resolve(new Response(JSON.stringify(years)));
      if (requestIndex === 2) return Promise.resolve(new Response(JSON.stringify([{ ...mockPeriods[0], fiscal_year_id: 'fy-2026' }])));
      if (requestIndex === 3) return new Promise<Response>(resolve => { resolveOld = resolve; });
      if (requestIndex === 4) return new Promise<Response>(resolve => { resolveLatest = resolve; });
      throw new Error(`Unexpected request ${requestIndex}`);
    }));

    const Probe = () => {
      const { selectedFiscalYearId, selectedPeriodId, onSelectFiscalYear } = useDateContext();
      return <><span data-testid="year">{selectedFiscalYearId}</span><span data-testid="period">{selectedPeriodId}</span>
        <button onClick={() => void onSelectFiscalYear('fy-2027')}>FY 2027</button>
        <button onClick={() => void onSelectFiscalYear('fy-2026')}>FY 2026</button></>;
    };
    render(<DateContextProvider companyId="company-1"><Probe /></DateContextProvider>);
    await waitFor(() => expect(screen.getByTestId('period')).toHaveTextContent('period-july-2026'));

    fireEvent.click(screen.getByRole('button', { name: 'FY 2027' }));
    fireEvent.click(screen.getByRole('button', { name: 'FY 2026' }));
    resolveLatest(new Response(JSON.stringify([{ id: 'period-2026-new', fiscal_year_id: 'fy-2026', period_start: '2026-11-01', period_end: '2026-11-30', status: 'open' }])));
    await waitFor(() => expect(screen.getByTestId('period')).toHaveTextContent('period-2026-new'));
    resolveOld(new Response(JSON.stringify([{ id: 'period-2027-old', fiscal_year_id: 'fy-2027', period_start: '2027-11-01', period_end: '2027-11-30', status: 'open' }])));

    await waitFor(() => expect(screen.getByTestId('year')).toHaveTextContent('fy-2026'));
    expect(screen.getByTestId('period')).toHaveTextContent('period-2026-new');
  });
});
