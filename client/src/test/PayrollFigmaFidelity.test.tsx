import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import i18n from '../i18n';
import { MonthlyPayroll } from '../components/MonthlyPayroll';
import { payrollMonthLabel } from '../components/payroll-month';
import { DateContext, type DateContextState } from '../context/DateContext';
import en from '../i18n/locales/en';
import ar from '../i18n/locales/ar';

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
const draft = { id: 'd1', period_month: '2026-11-01', currency_code: 'SAR', version: 1, status: 'approved', approved_at: '2026-11-24T09:15:00Z', approved_by_email: 'a@example.test', gross_earnings: '1.00', employee_deductions: '0.00', employer_contributions: '0.00', net_payable: '1.00' };
const accounts = [{ id: 'acc-asset', code: '1210', name: 'Employee advances', name_ar: 'سلف الموظفين', account_type: 'asset', is_active: true }];
const preview = (withMappingEntry: boolean) => ({
  totals: { earnings: '1.00', employee_deductions: '0.00', net_payable: '1.00', employer_contributions: '0.00', debit_total: '1.00', credit_total: '1.00' },
  mappings: withMappingEntry ? [{ mapping_key: 'employee_salary_advance_receivable', account_id: 'acc-asset', code: '1210', name: 'Employee advances', name_ar: 'سلف الموظفين', account_type: 'asset', is_active: true }] : [],
  lines: [{ mapping_key: 'employee_salary_advance_receivable', account_id: 'acc-asset', debit: '0.00', credit: '1.00' }],
  blockers: [], warnings: [], balanced: true, can_preview: true, authority: 'informational_only', posting_revalidation_required: true, side_effects: false,
});
const caps = ['payroll.view', 'payroll.accounting.mapping.view', 'payroll.accounting.preview', 'fiscal_year.view'];
const mock = (previewBody: unknown, fiscalYears: unknown[] = []) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  if (url === '/api/payroll/account-mappings') return ok({ mappings: [], accounts });
  if (url.includes('/accounting-preview')) return ok(previewBody);
  if (url === '/api/fiscal-years') return ok({ fiscalYears });
  if (url.includes('/accounting-post-status')) return ok({ journal: null, eligible: false, blockers: [], warnings: [] });
  if (url.includes('/api/payroll/drafts')) return ok({ draft, employees: [], available_employees: [], period_eligibility: { eligible: true } });
  return ok({});
}));
const openAccounting = async () => { fireEvent.click(await screen.findByRole('tab', { name: /Accounting & posting|المحاسبة والترحيل/ })); };

describe('Figma fidelity: payroll accounting and fiscal context', () => {
  beforeEach(() => { sessionStorage.clear(); sessionStorage.setItem('eqfal.payroll.selectedMonth.c1', '2026-11'); });
  afterEach(() => vi.unstubAllGlobals());

  it('has the recovery mapping label in Arabic and English', () => {
    expect((en as any).payroll.employee_salary_advance_receivable).toBeTruthy();
    expect((ar as any).payroll.employee_salary_advance_receivable).toBeTruthy();
  });

  it('shows the recovery account from the account list when the preview mappings omit it (no hardcoded code)', async () => {
    mock(preview(false));
    render(<MonthlyPayroll companyId="c1" capabilities={caps} onUnauthorized={() => {}} />);
    await openAccounting();
    const row = await screen.findByTestId('preview-line-employee_salary_advance_receivable');
    expect(row).toHaveTextContent('1210 · ');
    expect(row).not.toHaveTextContent('employee_salary_advance_receivable');
  });

  it('says plainly when the account cannot be resolved instead of leaving the cell blank', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/payroll/account-mappings' ? ok({ mappings: [], accounts: [] }) : url.includes('/accounting-preview') ? ok(preview(false)) : url === '/api/fiscal-years' ? ok({ fiscalYears: [] }) : url.includes('/accounting-post-status') ? ok({ journal: null, eligible: false, blockers: [], warnings: [] }) : ok({ draft, employees: [], available_employees: [], period_eligibility: { eligible: true } })));
    render(<MonthlyPayroll companyId="c1" capabilities={caps} onUnauthorized={() => {}} />);
    await openAccounting();
    const row = await screen.findByTestId('preview-line-employee_salary_advance_receivable');
    expect(row.querySelector('.payroll-account-unavailable')).not.toBeNull();
  });

  it('shows a non-blocking note when the header fiscal year differs from the payroll month, without changing the stored month', async () => {
    const fy = (id: string, name: string, s: string, e: string) => ({ id, company_id: 'c1', name, start_date: s, end_date: e, status: 'open' });
    const years = [fy('fy25', 'FY 2025', '2025-01-01', '2025-12-31'), fy('fy26', 'FY 2026', '2026-01-01', '2026-12-31')];
    mock(preview(true), years);
    const ctx = { availableFiscalYears: years, selectedFiscalYearId: 'fy25' } as unknown as DateContextState;
    render(<DateContext.Provider value={ctx}><MonthlyPayroll companyId="c1" capabilities={caps} onUnauthorized={() => {}} /></DateContext.Provider>);
    expect(await screen.findByTestId('fiscal-year-differs')).toBeInTheDocument();
    expect(screen.getByText('FY 2025')).toBeInTheDocument();
    expect(sessionStorage.getItem('eqfal.payroll.selectedMonth.c1')).toBe('2026-11');
    expect((document.querySelector('input[type="month"]') as HTMLInputElement).value).toBe('2026-11');
  });

  it('localizes the month name in both languages', async () => {
    expect(payrollMonthLabel('2026-11-01', 'en')).toBe('November 2026');
    expect(payrollMonthLabel('2026-11', 'ar')).toMatch(/نوفمبر/);
    expect(payrollMonthLabel('2026-11', 'ar')).toMatch(/2026/);
    await act(async () => { await i18n.changeLanguage('en'); });
  });
});
