import { describe, expect, it } from 'vitest';
import { PAGE_DESTINATIONS, canOpenDestination, destinationQuery } from '../navigation/pageDestinations';
import { navigateToQueryState } from '../navigation/queryState';

describe('deep navigation destination catalog', () => {
  it('covers every approved navigable tab category with URL-backed destinations', () => {
    const categories = new Set(PAGE_DESTINATIONS.map(destination => destination.page));
    expect(categories).toEqual(new Set(['accounting', 'banks', 'assets', 'documents', 'annualClosing', 'obligations', 'openingBalances', 'access']));
    expect(PAGE_DESTINATIONS.some(destination => destination.id.startsWith('partners.'))).toBe(false);
    expect(PAGE_DESTINATIONS.every(destination => Object.keys(destination.query ?? {}).length > 0)).toBe(true);
  });

  it('preserves exact query destinations and enforces parent, child, and system-admin boundaries', () => {
    const accounting = PAGE_DESTINATIONS.find(destination => destination.id === 'accounting.profitOrLoss')!;
    expect(destinationQuery(accounting)).toEqual({ accountingTab: 'profitOrLoss' });
    const bankingImport = PAGE_DESTINATIONS.find(destination => destination.id === 'banks.import')!;
    expect(canOpenDestination(bankingImport, ['bank.view'])).toBe(false);
    expect(canOpenDestination(bankingImport, ['bank.view', 'bank.import'])).toBe(true);
    const systemCompanies = PAGE_DESTINATIONS.find(destination => destination.id === 'access.global.companies')!;
    expect(canOpenDestination(systemCompanies, ['access.view'], false)).toBe(false);
    expect(canOpenDestination(systemCompanies, ['access.view'], true)).toBe(true);
    expect(canOpenDestination(systemCompanies, [], true)).toBe(false);
  });

  it('encodes every supported destination as a directly navigable page and query state', () => {
    for (const destination of PAGE_DESTINATIONS) {
      navigateToQueryState({ page: destination.page, ...destinationQuery(destination) });
      const params = new URLSearchParams(window.location.search);
      expect(params.get('page')).toBe(destination.page);
      for (const [key, value] of Object.entries(destinationQuery(destination))) expect(params.get(key)).toBe(value);
    }
  });
});
