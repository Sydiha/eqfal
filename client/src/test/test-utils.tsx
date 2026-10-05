import React, { useMemo } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { DateContext, DateContextState } from '../context/DateContext';

const createMockDateContext = (): DateContextState => ({
  companyId: 'test-company',
  selectedFiscalYearId: 'fy-test',
  availableFiscalYears: [],
  selectedPeriodId: null,
  availablePeriodsForSelectedYear: [],
  periodMode: 'specific',
  isLoading: false,
  error: null,
  onSelectFiscalYear: async () => {},
  onSelectPeriod: () => {},
  loadFiscalYears: async () => [],
  loadPeriodsForYear: async () => [],
});

interface AllTheProvidersProps {
  children: React.ReactNode;
  dateContextValue?: DateContextState;
}

const AllTheProviders = ({ children, dateContextValue }: AllTheProvidersProps) => {
  const contextValue = useMemo(() => dateContextValue || createMockDateContext(), [dateContextValue]);
  return <DateContext.Provider value={contextValue}>{children}</DateContext.Provider>;
};

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  dateContextValue?: DateContextState;
}

const customRender = (ui: React.ReactElement, options?: CustomRenderOptions) => {
  const { dateContextValue, ...renderOptions } = options || {};
  return render(ui, {
    wrapper: ({ children }) => <AllTheProviders dateContextValue={dateContextValue}>{children}</AllTheProviders>,
    ...renderOptions,
  });
};

export * from '@testing-library/react';
export { customRender as render };
