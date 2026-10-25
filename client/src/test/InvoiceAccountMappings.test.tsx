import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { InvoiceAccountMappings } from '../components/InvoiceAccountMappings';
import { canShowNavigationPage } from '../components/navigationVisibility';
import { NAV_GROUPS } from '../components/AppShell';

const acct = (id: string, code: string, name: string, name_ar: string) => ({ id, code, name, name_ar });
const asset = [acct('a1', '1100', 'Receivables', 'الذمم المدينة')];
const mk = (key: string, section: string, type: string, status: string, account: unknown, eligible: unknown[]) => ({ key, section, required_account_type: type, status, account, eligible_accounts: eligible });
const base = () => [
  mk('receivable', 'sales', 'asset', 'configured', { ...asset[0], is_active: true, account_type: 'asset' }, asset),
  mk('sales_revenue', 'sales', 'revenue', 'missing', null, [acct('r1', '4000', 'Sales', 'المبيعات')]),
  mk('vat_output', 'sales', 'liability', 'missing', null, []),
  mk('payable', 'purchases', 'liability', 'invalid', { id: 'p1', code: '2100', name: 'AP', name_ar: 'الدائنون', is_active: false, account_type: 'liability' }, []),
  mk('purchase_expense', 'purchases', 'expense', 'missing', null, []),
  mk('vat_input', 'purchases', 'asset', 'missing', null, asset),
];

function mockApi(onWrite?: (method: string, url: string, body: unknown) => Response | undefined) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method !== 'GET') { const r = onWrite?.(method, url, init?.body ? JSON.parse(String(init.body)) : undefined); if (r) return r; }
    return new Response(JSON.stringify({ mappings: base() }), { status: 200 });
  }));
  return calls;
}
beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('InvoiceAccountMappings', () => {
  it('makes no request and shows no data without view permission', () => {
    const calls = mockApi();
    render(<InvoiceAccountMappings canView={false} canManage={false} onUnauthorized={vi.fn()} />);
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('view-only: shows sales/purchases sections, statuses and accounts, with no editing controls', async () => {
    mockApi();
    render(<InvoiceAccountMappings canView canManage={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('1100 — Receivables')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sales' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Purchases' })).toBeInTheDocument();
    expect(screen.getByTestId('mapping-incomplete')).toHaveTextContent('5 mappings');
    expect(within(screen.getByTestId('mapping-payable')).getByText('Invalid')).toBeInTheDocument();
    expect(screen.getByTestId('mapping-readonly')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('manager must choose an account explicitly (nothing preselected) and saves with PUT', async () => {
    const calls = mockApi();
    render(<InvoiceAccountMappings canView canManage onUnauthorized={vi.fn()} />);
    const row = await screen.findByTestId('mapping-sales_revenue');
    const select = within(row).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('');
    const save = within(row).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(select, { target: { value: 'r1' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls).toContain('PUT /api/invoice-account-mappings/sales_revenue'));
    expect(await screen.findByTestId('mapping-notice')).toHaveTextContent('Sales revenue saved.');
  });

  it('requires confirmation before clearing', async () => {
    const calls = mockApi();
    render(<InvoiceAccountMappings canView canManage onUnauthorized={vi.fn()} />);
    fireEvent.click(within(await screen.findByTestId('mapping-receivable')).getByRole('button', { name: 'Clear' }));
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    fireEvent.click(within(screen.getByTestId('mapping-receivable')).getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear mapping' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/invoice-account-mappings/receivable'));
    expect(await screen.findByTestId('mapping-notice')).toHaveTextContent('Accounts receivable cleared.');
  });

  it('shows a validation message when the server rejects the account, and an authorization message on 403', async () => {
    mockApi((m) => new Response('{}', { status: m === 'PUT' ? 400 : 403 }));
    render(<InvoiceAccountMappings canView canManage onUnauthorized={vi.fn()} />);
    const row = await screen.findByTestId('mapping-sales_revenue');
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'r1' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not valid for this mapping');
    fireEvent.click(within(screen.getByTestId('mapping-receivable')).getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear mapping' }));
    expect(await screen.findByText(/do not have permission/)).toBeInTheDocument();
  });

  it('renders Arabic labels and RTL-friendly account names', async () => {
    await i18n.changeLanguage('ar');
    mockApi();
    render(<InvoiceAccountMappings canView canManage={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('1100 — الذمم المدينة')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'المبيعات' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'المشتريات' })).toBeInTheDocument();
    expect(screen.getByTestId('mapping-payable')).toHaveTextContent('غير صالح');
  });
});

describe('navigation visibility', () => {
  it('lives in the invoices group and needs view; manage alone and other invoice capabilities do not show it', () => {
    expect(NAV_GROUPS.find((g) => g.id === 'invoices')!.pages).toContain('invoiceMappings');
    expect(canShowNavigationPage('invoiceMappings', ['invoice.mapping.view'])).toBe(true);
    expect(canShowNavigationPage('invoiceMappings', ['invoice.mapping.manage'])).toBe(false);
    expect(canShowNavigationPage('invoiceMappings', ['invoice.view', 'invoice.approve', 'accounting.view'])).toBe(false);
    expect(canShowNavigationPage('invoiceMappings', [])).toBe(false);
  });
});
