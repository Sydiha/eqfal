import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';

export interface FiscalYear {
  id: string;
  company_id: string;
  name: string;
  start_date: string; // ISO date
  end_date: string;   // ISO date
  status: string;
}

export interface Period {
  id: string;
  fiscal_year_id: string;
  period_start: string; // ISO date
  period_end: string;   // ISO date
  status: string;
}

export interface DateContextState {
  companyId: string;
  selectedFiscalYearId: string | null;
  availableFiscalYears: FiscalYear[];
  selectedPeriodId: string | null;
  availablePeriodsForSelectedYear: Period[];
  periodMode: 'all' | 'specific';
  isLoading: boolean;
  error: string | null;
  onSelectFiscalYear: (id: string) => Promise<void>;
  onSelectPeriod: (id: string, mode?: 'all' | 'specific') => void;
  loadFiscalYears: () => Promise<void>;
  loadPeriodsForYear: (fiscalYearId: string) => Promise<Period[]>;
}

/** Id prefix for calendar months of a fiscal year that have no monthly-close record yet (UI-only, never persisted to the backend). */
export const MONTH_PERIOD_PREFIX = 'month:';
export const isMonthOnlyPeriodId = (id: string | null | undefined): id is string =>
  typeof id === 'string' && id.startsWith(MONTH_PERIOD_PREFIX);

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Full calendar-month list for a fiscal year: the real monthly-close period when one exists,
 * otherwise a UI-only month entry clipped to the fiscal-year bounds.
 */
export function buildYearMonths(year: FiscalYear | undefined, realPeriods: Period[]): Period[] {
  if (!year) return realPeriods;
  const fyStart = year.start_date.slice(0, 10);
  const fyEnd = year.end_date.slice(0, 10);
  const byMonth = new Map(realPeriods.map(p => [p.period_start.slice(0, 7), p]));
  const months: Period[] = [];
  const cursor = new Date(`${fyStart.slice(0, 7)}-01T00:00:00Z`);
  while (isoDay(cursor) <= fyEnd && months.length < 24) {
    const key = isoDay(cursor).slice(0, 7);
    const real = byMonth.get(key);
    if (real) {
      months.push(real);
    } else {
      const monthStart = isoDay(cursor);
      const monthEnd = isoDay(new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)));
      months.push({
        id: `${MONTH_PERIOD_PREFIX}${key}`,
        fiscal_year_id: year.id,
        period_start: monthStart < fyStart ? fyStart : monthStart,
        period_end: monthEnd > fyEnd ? fyEnd : monthEnd,
        status: 'not_created',
      });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
  }
  return months;
}

export const DateContext = createContext<DateContextState | undefined>(undefined);

export const useDateContext = () => {
  const context = useContext(DateContext);
  if (!context) {
    throw new Error('useDateContext must be used within DateContextProvider');
  }
  return context;
};

interface DateContextProviderProps {
  children: React.ReactNode;
  companyId: string;
}

export const DateContextProvider: React.FC<DateContextProviderProps> = ({ children, companyId }) => {
  const [selectedFiscalYearId, setSelectedFiscalYearId] = useState<string | null>(null);
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
  const [periodMode, setPeriodMode] = useState<'all' | 'specific'>('specific');
  const [availableFiscalYears, setAvailableFiscalYears] = useState<FiscalYear[]>([]);
  const [availablePeriodsForSelectedYear, setAvailablePeriodsForSelectedYear] = useState<Period[]>([]);
  const [realPeriodsForSelectedYear, setRealPeriodsForSelectedYear] = useState<Period[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const periodsRequest = useRef(0);
  const yearSelection = useRef(0);
  const periodModeRef = useRef<'all' | 'specific'>('specific');

  // localStorage key helpers
  const getStorageKey = (suffix: string) => `eqfal_${suffix}_${companyId}`;

  // Load fiscal years
  const loadFiscalYears = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/fiscal-years');
      if (!response.ok) throw new Error('Failed to load fiscal years');
      const data = await response.json();
      const years = Array.isArray(data) ? data : data.fiscalYears || [];
      setAvailableFiscalYears(years);
      return years;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load periods for a specific fiscal year
  const loadPeriodsForYear = useCallback(async (fiscalYearId: string) => {
    const requestId = ++periodsRequest.current;
    setIsLoading(true);
    try {
      const response = await fetch('/api/monthly-close-periods');
      if (!response.ok) throw new Error('Failed to load periods');
      const data = await response.json();
      const allPeriods = Array.isArray(data) ? data : data.periods || [];
      const yearPeriods: Period[] = allPeriods.filter((p: Period) => p.fiscal_year_id === fiscalYearId);
      if (requestId === periodsRequest.current) setRealPeriodsForSelectedYear(yearPeriods);
      return yearPeriods;
    } catch (err) {
      if (requestId === periodsRequest.current) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(message);
      }
      throw err;
    } finally {
      if (requestId === periodsRequest.current) setIsLoading(false);
    }
  }, []);

  // Expose all calendar months of the selected year; months without a monthly-close record are UI-only entries.
  useEffect(() => {
    const year = availableFiscalYears.find(y => y.id === selectedFiscalYearId);
    setAvailablePeriodsForSelectedYear(
      year && typeof year.start_date === 'string' && typeof year.end_date === 'string' && realPeriodsForSelectedYear.every(p => p.fiscal_year_id === year.id)
        ? buildYearMonths(year, realPeriodsForSelectedYear)
        : realPeriodsForSelectedYear,
    );
  }, [availableFiscalYears, selectedFiscalYearId, realPeriodsForSelectedYear]);

  // Determine default fiscal year using approval logic
  const determineDefaultFiscalYear = useCallback((years: FiscalYear[]): FiscalYear | null => {
    if (years.length === 0) return null;

    // Check persisted value first
    const persistedId = localStorage.getItem(getStorageKey('selectedFiscalYearId'));
    if (persistedId) {
      const persisted = years.find(y => y.id === persistedId);
      if (persisted) return persisted;
    }

    // Find fiscal year containing today
    const today = new Date();
    for (const year of years) {
      const startDate = new Date(year.start_date);
      const endDate = new Date(year.end_date);
      if (startDate <= today && today <= endDate) {
        return year;
      }
    }

    // Find most recent by start_date
    return years.reduce((latest, current) =>
      new Date(current.start_date) > new Date(latest.start_date) ? current : latest
    );
  }, [companyId]);

  // Initialize fiscal years and selected year on mount or companyId change
  useEffect(() => {
    const selectionId = ++yearSelection.current;
    // Clear the previous company's date state before fetching the new company's data
    setAvailableFiscalYears([]);
    setSelectedFiscalYearId(null);
    setRealPeriodsForSelectedYear([]);
    setSelectedPeriodId(null);
    const initialize = async () => {
      try {
        const years = await loadFiscalYears();
        if (selectionId !== yearSelection.current) return;
        const defaultYear = determineDefaultFiscalYear(years);
        if (defaultYear) {
          setSelectedFiscalYearId(defaultYear.id);
          const periods = await loadPeriodsForYear(defaultYear.id);
          if (selectionId !== yearSelection.current) return;

          // Set default period
          const persistedPeriodId = localStorage.getItem(getStorageKey('selectedPeriodId'));
          const periodMode = (localStorage.getItem(getStorageKey('periodMode')) || 'specific') as 'all' | 'specific';
          periodModeRef.current = periodMode;
          setPeriodMode(periodMode);

          if (persistedPeriodId && periodMode === 'specific' && periods.some(period => period.id === persistedPeriodId)) {
            setSelectedPeriodId(persistedPeriodId);
          } else if (periodMode === 'specific') {
            // Select most recent period
            if (periods.length > 0) {
              const defaultPeriodId = periods[periods.length - 1].id;
              setSelectedPeriodId(defaultPeriodId);
              localStorage.setItem(getStorageKey('selectedPeriodId'), defaultPeriodId);
            } else {
              setSelectedPeriodId(null);
              localStorage.removeItem(getStorageKey('selectedPeriodId'));
            }
          }
        }
      } catch (err) {
        console.error('Failed to initialize DateContext:', err);
      }
    };

    void initialize();
    return () => { yearSelection.current++; };
  }, [companyId, loadFiscalYears, loadPeriodsForYear, determineDefaultFiscalYear]);

  // Handle fiscal year change
  const onSelectFiscalYear = useCallback(async (id: string) => {
    const selectionId = ++yearSelection.current;
    // Clear the prior period immediately so reports cannot keep using another year's period
    // while the newly selected year's periods are loading.
    setRealPeriodsForSelectedYear([]);
    setSelectedPeriodId(null);
    setSelectedFiscalYearId(id);
    localStorage.setItem(getStorageKey('selectedFiscalYearId'), id);

    const periods = await loadPeriodsForYear(id);
    if (selectionId === yearSelection.current && periods.length > 0 && periodModeRef.current === 'specific') {
      setSelectedPeriodId(periods[0].id);
      localStorage.setItem(getStorageKey('selectedPeriodId'), periods[0].id);
    }
  }, [loadPeriodsForYear, companyId]);

  // Handle period change
  const onSelectPeriod = useCallback((id: string, mode: 'all' | 'specific' = 'specific') => {
    yearSelection.current++;
    if (mode === 'all') {
      periodModeRef.current = 'all';
      setPeriodMode('all');
      setSelectedPeriodId(null);
      localStorage.setItem(getStorageKey('periodMode'), 'all');
      localStorage.removeItem(getStorageKey('selectedPeriodId'));
    } else {
      periodModeRef.current = 'specific';
      setPeriodMode('specific');
      setSelectedPeriodId(id);
      localStorage.setItem(getStorageKey('periodMode'), 'specific');
      localStorage.setItem(getStorageKey('selectedPeriodId'), id);
    }
  }, [companyId]);

  const value: DateContextState = {
    companyId,
    selectedFiscalYearId,
    availableFiscalYears,
    selectedPeriodId,
    availablePeriodsForSelectedYear,
    periodMode,
    isLoading,
    error,
    onSelectFiscalYear,
    onSelectPeriod,
    loadFiscalYears,
    loadPeriodsForYear,
  };

  return <DateContext.Provider value={value}>{children}</DateContext.Provider>;
};
