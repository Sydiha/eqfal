import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

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

interface DateContextState {
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
  loadPeriodsForYear: (fiscalYearId: string) => Promise<void>;
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
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // localStorage key helpers
  const getStorageKey = (suffix: string) => `eqfal_${suffix}_${companyId}`;

  // Load fiscal years
  const loadFiscalYears = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/fiscal-years');
      if (!response.ok) throw new Error('Failed to load fiscal years');
      const years = await response.json();
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
    try {
      setIsLoading(true);
      const response = await fetch('/api/monthly-close-periods');
      if (!response.ok) throw new Error('Failed to load periods');
      const allPeriods = await response.json();
      const yearPeriods = allPeriods.filter((p: Period) => p.fiscal_year_id === fiscalYearId);
      setAvailablePeriodsForSelectedYear(yearPeriods);
      return yearPeriods;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

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
    const initialize = async () => {
      try {
        const years = await loadFiscalYears();
        const defaultYear = determineDefaultFiscalYear(years);
        if (defaultYear) {
          setSelectedFiscalYearId(defaultYear.id);
          const periods = await loadPeriodsForYear(defaultYear.id);

          // Set default period
          const persistedPeriodId = localStorage.getItem(getStorageKey('selectedPeriodId'));
          const periodMode = (localStorage.getItem(getStorageKey('periodMode')) || 'specific') as 'all' | 'specific';
          setPeriodMode(periodMode);

          if (persistedPeriodId && periodMode === 'specific') {
            setSelectedPeriodId(persistedPeriodId);
          } else if (!persistedPeriodId && periodMode === 'specific') {
            // Select most recent period
            if (periods.length > 0) {
              setSelectedPeriodId(periods[periods.length - 1].id);
            }
          }
        }
      } catch (err) {
        console.error('Failed to initialize DateContext:', err);
      }
    };

    initialize();
  }, [companyId, loadFiscalYears, loadPeriodsForYear, determineDefaultFiscalYear]);

  // Handle fiscal year change
  const onSelectFiscalYear = useCallback(async (id: string) => {
    setSelectedFiscalYearId(id);
    localStorage.setItem(getStorageKey('selectedFiscalYearId'), id);

    const periods = await loadPeriodsForYear(id);
    if (periods.length > 0 && periodMode === 'specific') {
      setSelectedPeriodId(periods[0].id);
      localStorage.setItem(getStorageKey('selectedPeriodId'), periods[0].id);
    }
  }, [loadPeriodsForYear, periodMode, companyId]);

  // Handle period change
  const onSelectPeriod = useCallback((id: string, mode: 'all' | 'specific' = 'specific') => {
    if (mode === 'all') {
      setPeriodMode('all');
      setSelectedPeriodId(null);
      localStorage.setItem(getStorageKey('periodMode'), 'all');
      localStorage.removeItem(getStorageKey('selectedPeriodId'));
    } else {
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
