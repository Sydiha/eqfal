import { describe, expect, it } from 'vitest';
import { canShowNavigationPage } from './navigationVisibility';

describe('manager workspace navigation boundary', () => {
  it('keeps the daily manager path visible from operational view capabilities', () => {
    const capabilities = ['document.view', 'obligation.view', 'bank.view', 'asset.view'];

    expect(canShowNavigationPage('home', capabilities)).toBe(true);
    expect(canShowNavigationPage('sales', capabilities)).toBe(true);
    expect(canShowNavigationPage('purchases', capabilities)).toBe(true);
    expect(canShowNavigationPage('documents', capabilities)).toBe(true);
    expect(canShowNavigationPage('banks', capabilities)).toBe(true);
    expect(canShowNavigationPage('obligations', capabilities)).toBe(true);
    expect(canShowNavigationPage('assets', capabilities)).toBe(true);
  });

  it('hides accounting, tax, close, fiscal-year, and administration destinations without their view capabilities', () => {
    const capabilities = ['document.view', 'obligation.view'];

    expect(canShowNavigationPage('accounting', capabilities)).toBe(false);
    expect(canShowNavigationPage('vat', capabilities)).toBe(false);
    expect(canShowNavigationPage('monthlyClose', capabilities)).toBe(false);
    expect(canShowNavigationPage('fiscalYears', capabilities)).toBe(false);
    expect(canShowNavigationPage('annualClosing', capabilities)).toBe(false);
    expect(canShowNavigationPage('openingBalances', capabilities)).toBe(false);
    expect(canShowNavigationPage('periodicAdjustments', capabilities)).toBe(false);
    expect(canShowNavigationPage('partners', capabilities)).toBe(false);
    expect(canShowNavigationPage('companyProfile', capabilities)).toBe(false);
    expect(canShowNavigationPage('access', capabilities)).toBe(false);
  });

  it('shows each specialist destination only when its matching view capability is present', () => {
    expect(canShowNavigationPage('accounting', ['accounting.view'])).toBe(true);
    expect(canShowNavigationPage('vat', ['vat.view'])).toBe(true);
    expect(canShowNavigationPage('monthlyClose', ['monthly_close.view'])).toBe(true);
    expect(canShowNavigationPage('fiscalYears', ['fiscal_year.view'])).toBe(true);
    expect(canShowNavigationPage('annualClosing', ['annual_close.view'])).toBe(true);
    expect(canShowNavigationPage('openingBalances', ['opening_balance.view'])).toBe(true);
    expect(canShowNavigationPage('periodicAdjustments', ['periodic_adjustment.view'])).toBe(true);
    expect(canShowNavigationPage('partners', ['partner.view'])).toBe(true);
    expect(canShowNavigationPage('companyProfile', ['company_accounting_profile.view'])).toBe(true);
    expect(canShowNavigationPage('access', ['access.view'])).toBe(true);
    expect(canShowNavigationPage('access', ['access.manage'])).toBe(false);
    expect(canShowNavigationPage('companies', ['company.view'])).toBe(true);
    expect(canShowNavigationPage('companies', ['access.view'])).toBe(false);
  });

  it('requires both document and obligation visibility for sales and purchases discovery', () => {
    expect(canShowNavigationPage('sales', ['document.view'])).toBe(false);
    expect(canShowNavigationPage('sales', ['obligation.view'])).toBe(false);
    expect(canShowNavigationPage('purchases', ['document.view'])).toBe(false);
    expect(canShowNavigationPage('purchases', ['obligation.view'])).toBe(false);
  });
});
