import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { InvoiceAccountMappings } from '../components/InvoiceAccountMappings';
import { canShowNavigationPage } from '../components/navigationVisibility';
import { NAV_GROUPS } from '../components/AppShell';

const acct = (id: string, code: string, name: string, name_ar: string) => ({ id, code, name, name_ar });
const asset = [acct('a1', '1100', 'Receivables', 'الذمم المدينة'), acct('a2', '1150', 'Other receivables', 'ذمم مدينة أخرى')];
const mk = (key: string, section: string, type: string, status: string, account: unknown, eligible: unknown[]) => ({ key, section, required_account_type: type, status, account, eligible_accounts: eligible });
// Server order (receivable first); the page shows missing/invalid first within each section.
const base = () => [
  mk('receivable', 'sales', 'asset', 'configured', { ...asset[0], is_active: true, account_type: 'asset' }, asset),
  mk('sales_revenue', 'sales', 'revenue', 'missing', null, [acct('r1', '4000', 'Sales', 'المبيعات')]),
  mk('vat_output', 'sales', 'liability', 'configured', { id: 'l2', code: '2300', name: 'VAT payable', name_ar: 'ضريبة مستحقة', is_active: true, account_type: 'liability' }, [acct('l2', '2300', 'VAT payable', 'ضريبة مستحقة')]),
  mk('payable', 'purchases', 'liability', 'invalid', { id: 'p1', code: '2100', name: 'AP', name_ar: 'الدائنون', is_active: false, account_type: 'liability' }, []),
  mk('purchase_expense', 'purchases', 'expense', 'missing', null, []),
  mk('vat_input', 'purchases', 'asset', 'invalid', { id: 'r2', code: '4100', name: 'Service revenue', name_ar: 'إيرادات الخدمات', is_active: true, account_type: 'revenue' }, asset),
];
const allConfigured = () => base().map((m) => ({ ...m, status: 'configured', account: m.account ?? { id: 'z', code: '9', name: 'Z', name_ar: 'ز', is_active: true, account_type: m.required_account_type } }));

function mockApi(onWrite?: (method: string, url: string, body: unknown) => Response | Promise<Response> | undefined, data = base) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method !== 'GET') { const r = await onWrite?.(method, url, init?.body ? JSON.parse(String(init.body)) : undefined); if (r) return r; }
    return new Response(JSON.stringify({ mappings: data() }), { status: 200 });
  }));
  return calls;
}
const ok = () => new Response(JSON.stringify({ mappings: base() }), { status: 200 });
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
    expect(await screen.findByTestId('mapping-receivable')).toHaveTextContent('1100 — Receivables');
    expect(screen.getByRole('heading', { name: 'Sales' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Purchases' })).toBeInTheDocument();
    expect(screen.getByTestId('mapping-incomplete')).toHaveTextContent('4 mappings');
    expect(within(screen.getByTestId('mapping-payable')).getByText('Invalid')).toBeInTheDocument();
    expect(screen.getByTestId('mapping-readonly')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('lists missing then invalid then configured within each section, and names them in the summary', async () => {
    mockApi();
    render(<InvoiceAccountMappings canView canManage={false} onUnauthorized={vi.fn()} />);
    await screen.findByTestId('mapping-receivable');
    const order = (heading: string) => Array.from(screen.getByRole('list', { name: heading }).querySelectorAll('li')).map((li) => li.getAttribute('data-testid'));
    expect(order('Sales')).toEqual(['mapping-sales_revenue', 'mapping-receivable', 'mapping-vat_output']);
    expect(order('Purchases')).toEqual(['mapping-purchase_expense', 'mapping-payable', 'mapping-vat_input']);
    const summary = screen.getByTestId('mapping-incomplete');
    expect(summary).toHaveTextContent('Missing: Sales revenue, Purchase expense.');
    expect(summary).toHaveTextContent('Invalid: Accounts payable, Input VAT.');
  });

  it('distinguishes missing (warning) from invalid (error) and explains each invalid condition', async () => {
    mockApi();
    render(<InvoiceAccountMappings canView canManage={false} onUnauthorized={vi.fn()} />);
    const missing = await screen.findByTestId('mapping-sales_revenue');
    expect(within(missing).getByText('Missing')).toHaveClass('incomplete');
    expect(missing).toHaveTextContent('No account set yet');
    const inactive = screen.getByTestId('mapping-payable');
    expect(within(inactive).getByText('Invalid')).toHaveClass('rejected');
    expect(inactive).toHaveTextContent('Inactive');
    expect(inactive).toHaveTextContent('The current account is inactive.');
    const wrongType = screen.getByTestId('mapping-vat_input');
    expect(wrongType).toHaveTextContent('Actual type: Revenue');
    expect(wrongType).toHaveTextContent('The current account type (Revenue) does not match the required type (Asset).');
    const configured = screen.getByTestId('mapping-receivable');
    expect(within(configured).getByText('Configured')).toHaveClass('approved');
    expect(configured).toHaveTextContent('Actual type: Asset');
    expect(configured).toHaveTextContent('Active');
  });

  it('shows the all-configured state when nothing is missing or invalid', async () => {
    mockApi(undefined, allConfigured);
    render(<InvoiceAccountMappings canView canManage={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByTestId('mapping-complete')).toHaveTextContent('All mappings are configured and valid.');
    expect(screen.queryByTestId('mapping-incomplete')).toBeNull();
  });

  it('no eligible accounts: warns on an unusable mapping, but says a valid mapping stays valid when there is no alternative', async () => {
    mockApi();
    render(<InvoiceAccountMappings canView canManage onUnauthorized={vi.fn()} />);
    const noneForMissing = await screen.findByTestId('mapping-no-eligible-purchase_expense');
    expect(noneForMissing).toHaveTextContent('There are no active Expense accounts');
    expect(noneForMissing).toHaveClass('is-warning');
    const noAlternative = screen.getByTestId('mapping-no-eligible-vat_output');
    expect(noAlternative).toHaveTextContent('The current mapping remains valid.');
    expect(noAlternative).not.toHaveClass('is-warning');
    expect(within(screen.getByTestId('mapping-vat_output')).queryByRole('combobox')).toBeNull();
    expect(within(screen.getByTestId('mapping-vat_output')).getByRole('button', { name: 'Clear Output VAT' })).toBeEnabled();
  });

  it('manager must choose an account explicitly (nothing preselected) and saves with PUT', async () => {
    let body: unknown;
    const calls = mockApi((_m, _u, b) => { body = b; return undefined; });
    render(<InvoiceAccountMappings canView canManage onUnauthorized={vi.fn()} />);
    const row = await screen.findByTestId('mapping-sales_revenue');
    const select = within(row).getByRole('combobox', { name: 'Account for Sales revenue' }) as HTMLSelectElement;
    expect(select.value).toBe('');
    const save = within(row).getByRole('button', { name: 'Save Sales revenue' });
    expect(save).toBeDisabled();
    fireEvent.change(select, { target: { value: 'r1' } });
    expect(screen.getByTestId('mapping-compare-sales_revenue')).toHaveTextContent('This account will be set for the first time.');
    fireEvent.click(save);
    await waitFor(() => expect(calls).toContain('PUT /api/invoice-account-mappings/sales_revenue'));
    expect(body).toEqual({ account_id: 'r1' });
    expect(await screen.findByTestId('mapping-notice')).toHaveTextContent('Sales revenue saved.');
  });

  it('replacement shows current → selected and an unsaved-change marker; the current account is not offered again', async () => {
    mockApi();
    render(<InvoiceAccountMappings canView canManage onUnauthorized={vi.fn()} />);
    const row = await screen.findByTestId('mapping-receivable');
    const select = within(row).getByRole('combobox', { name: 'Account for Accounts receivable' });
    expect(within(select).queryByRole('option', { name: '1100 — Receivables' })).toBeNull();
    expect(screen.queryByTestId('mapping-unsaved-receivable')).toBeNull();
    fireEvent.change(select, { target: { value: 'a2' } });
    const compare = screen.getByTestId('mapping-compare-receivable');
    expect(compare).toHaveTextContent('Current1100 — Receivables');
    expect(compare).toHaveTextContent('Selected1150 — Other receivables');
    expect(screen.getByTestId('mapping-unsaved-receivable')).toHaveTextContent('Unsaved change');
    fireEvent.change(select, { target: { value: '' } });
    expect(screen.queryByTestId('mapping-compare-receivable')).toBeNull();
  });

  it('shows progress on the affected row and blocks every other save/clear until the request completes', async () => {
    let release!: () => void;
    const calls = mockApi(() => new Promise<Response>((resolve) => { release = () => resolve(ok()); }));
    render(<InvoiceAccountMappings canView canManage onUnauthorized={vi.fn()} />);
    const row = await screen.findByTestId('mapping-sales_revenue');
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'r1' } });
    fireEvent.change(within(screen.getByTestId('mapping-receivable')).getByRole('combobox'), { target: { value: 'a2' } });
    const save = within(row).getByRole('button', { name: 'Save Sales revenue' });
    fireEvent.click(save);
    expect(await screen.findByTestId('mapping-busy')).toHaveTextContent('Saving the account mapping. Please wait until the operation finishes.');
    expect(row).toHaveAttribute('aria-busy', 'true');
    expect(save).toHaveTextContent('Saving…');
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled();
    fireEvent.click(save);
    fireEvent.click(within(screen.getByTestId('mapping-receivable')).getByRole('button', { name: 'Save Accounts receivable' }));
    expect(calls.filter((c) => c.startsWith('PUT'))).toHaveLength(1);
    await act(async () => { release(); });
    await waitFor(() => expect(screen.queryByTestId('mapping-busy')).toBeNull());
    expect(within(screen.getByTestId('mapping-receivable')).getByRole('button', { name: 'Save Accounts receivable' })).toBeEnabled();
  });

  it('requires confirmation before clearing, names the current account, and returns focus on cancel', async () => {
    const calls = mockApi();
    render(<InvoiceAccountMappings canView canManage onUnauthorized={vi.fn()} />);
    const clear = within(await screen.findByTestId('mapping-receivable')).getByRole('button', { name: 'Clear Accounts receivable' });
    clear.focus();
    fireEvent.click(clear);
    const dialog = screen.getByRole('dialog', { name: 'Clear this mapping?' });
    expect(dialog).toHaveTextContent('Current account: 1100 — Receivables');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(clear).toHaveFocus();
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    fireEvent.click(clear);
    fireEvent.click(screen.getByRole('button', { name: 'Clear mapping' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/invoice-account-mappings/receivable'));
    expect(await screen.findByTestId('mapping-notice')).toHaveTextContent('Accounts receivable cleared.');
  });

  it('shows a validation message when the server rejects the account, and an authorization message on 403, never the raw server text', async () => {
    mockApi((m) => new Response(JSON.stringify({ error: 'Mapping x requires an account of type y', code: 'INVOICE_VALIDATION' }), { status: m === 'PUT' ? 400 : 403 }));
    render(<InvoiceAccountMappings canView canManage onUnauthorized={vi.fn()} />);
    const row = await screen.findByTestId('mapping-sales_revenue');
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'r1' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save Sales revenue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not valid for this mapping');
    expect(screen.queryByText(/requires an account of type/)).toBeNull();
    fireEvent.click(within(screen.getByTestId('mapping-receivable')).getByRole('button', { name: 'Clear Accounts receivable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear mapping' }));
    expect(await screen.findByText(/do not have permission/)).toBeInTheDocument();
  });

  it('offers Retry after a loading failure and loads again', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async () => fail ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ mappings: base() }), { status: 200 })));
    render(<InvoiceAccountMappings canView canManage={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load or save the mappings.');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('mapping-receivable')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders Arabic labels, isolates account codes, and keeps the owner wording for saving', async () => {
    await i18n.changeLanguage('ar');
    let release!: () => void;
    mockApi(() => new Promise<Response>((resolve) => { release = () => resolve(ok()); }));
    render(<InvoiceAccountMappings canView canManage onUnauthorized={vi.fn()} />);
    const receivable = await screen.findByTestId('mapping-receivable');
    expect(receivable).toHaveTextContent('1100 — الذمم المدينة');
    expect(receivable.querySelector('bdi.invoice-mappings__code')).toHaveTextContent('1100');
    expect(screen.getByRole('heading', { name: 'المبيعات' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'المشتريات' })).toBeInTheDocument();
    expect(screen.getByTestId('mapping-payable')).toHaveTextContent('غير صالح');
    expect(within(screen.getByTestId('mapping-sales_revenue')).getByText('ناقص')).toHaveClass('incomplete');
    expect(screen.getByTestId('mapping-no-eligible-vat_output')).toHaveTextContent('الربط الحالي ما زال صالحًا.');
    const row = screen.getByTestId('mapping-sales_revenue');
    fireEvent.change(within(row).getByRole('combobox', { name: 'حساب إيرادات المبيعات' }), { target: { value: 'r1' } });
    fireEvent.click(within(row).getByRole('button', { name: 'حفظ إيرادات المبيعات' }));
    expect(await screen.findByTestId('mapping-busy')).toHaveTextContent('جارٍ حفظ ربط الحساب. يُرجى الانتظار حتى تكتمل العملية.');
    await act(async () => { release(); });
  });

  it('has an Arabic translation for every new English key', async () => {
    const en = i18n.getResourceBundle('en', 'translation').invoiceMappings as Record<string, unknown>;
    const ar = i18n.getResourceBundle('ar', 'translation').invoiceMappings as Record<string, unknown>;
    for (const key of Object.keys(en)) if (!key.startsWith('incomplete_')) expect(ar[key], key).toBeDefined();
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
