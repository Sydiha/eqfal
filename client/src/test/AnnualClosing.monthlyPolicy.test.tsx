import { fireEvent, screen, waitFor } from './test-utils';
import { render } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { AnnualClosing } from '../components/AnnualClosing';

const readiness = (policy: 'required' | 'optional', yearStatus = 'open') => ({
  fiscal_year: { id: 'fy-1', name: 'FY', start_date: '2026-01-01', end_date: '2026-12-31', status: yearStatus, monthly_close_policy: policy },
  ready: true, blocker_count: 0,
  financial_statements_readiness: { status: 'ready', label: 'Ready', label_ar: 'جاهز' },
  zakat_readiness: { status: 'ready' }, package_manifest: [],
  domains: { monthly_close: { ready: true, blocker_count: 0, status: 'ready', summary: { expected_periods: 12, closed_periods: 5, open_periods: 7, missing_periods: 0 } } },
});

function mockFetch(policy: 'required' | 'optional', yearStatus = 'open') {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/fiscal-years') return new Response(JSON.stringify({ fiscalYears: [{ id: 'fy-1', name: 'FY', start_date: '2026-01-01', end_date: '2026-12-31' }] }), { status: 200 });
    if (url === '/api/fiscal-years/fy-1/monthly-close-policy') return new Response(JSON.stringify({ fiscalYear: {} }), { status: 200 });
    if (url === '/api/annual-closing/fy-1') return new Response(JSON.stringify(readiness(policy, yearStatus)), { status: 200 });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return calls;
}

describe('Annual closing monthly policy card', () => {
  beforeEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage('en'); });

  it('shows the policy and the actual monthly statuses without a selector for users who cannot manage it', async () => {
    mockFetch('optional');
    render(<AnnualClosing canView onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('Monthly closing policy')).toBeInTheDocument();
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.getByText(/5 closed, 7 open, 0 not created \(of 12 expected\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save policy' })).not.toBeInTheDocument();
  });

  it('lets an authorised user change the policy of an open year', async () => {
    const calls = mockFetch('required');
    render(<AnnualClosing canView canManageMonthlyPolicy onUnauthorized={vi.fn()} />);
    const save = await screen.findByRole('button', { name: 'Save policy' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: /Policy/ }), { target: { value: 'optional' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ policy: 'optional' }));
  });

  it('hides the selector once the fiscal year is closed and says the policy is locked', async () => {
    mockFetch('optional', 'closed');
    render(<AnnualClosing canView canManageMonthlyPolicy onUnauthorized={vi.fn()} />);
    expect(await screen.findByText(/policy can no longer change/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save policy' })).not.toBeInTheDocument();
  });

  it('renders in Arabic', async () => {
    await i18n.changeLanguage('ar');
    mockFetch('required');
    render(<AnnualClosing canView canManageMonthlyPolicy onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('سياسة الإقفال الشهري')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ السياسة' })).toBeInTheDocument();
  });
});
