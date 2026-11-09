import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { Accounting } from '../components/Accounting';
import { localizedAccountName, localizedLegacyAccountName, normalizeFinancialAmount } from '../components/accounting-contracts';

// Task 30B: bilingual account names with legacy `name` fallback.
const accounts = [
  { id: '00000000-0000-4000-8000-000000000001', code: '1000', name: 'النقدية', name_ar: 'النقدية', name_en: 'Cash', account_type: 'asset', parent_account_id: null, is_active: true },
  { id: '00000000-0000-4000-8000-000000000002', code: '1100', name: 'Legacy Bank', name_ar: null, name_en: null, account_type: 'asset', parent_account_id: '00000000-0000-4000-8000-000000000001', is_active: true },
];
const stub = () => {
  const classificationAccounts = accounts.map((account) => ({ ...account, statement_category: 'current_asset', is_contra: false, cash_role: 'cash', cash_flow_category: 'operating' }));
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/accounts' && options?.method === 'POST') return new Response(JSON.stringify({ id: 'new' }), { status: 201 });
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts }));
    if (url.startsWith('/api/account-classifications')) return new Response(JSON.stringify({ accounts: classificationAccounts }));
    if (url === '/api/fiscal-years') return new Response(JSON.stringify({ fiscalYears: [] }));
    if (url === '/api/journals') return new Response(JSON.stringify({ journals: [] }));
    return new Response(JSON.stringify({ sources: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const ui = () => <Accounting canView canCreateChart canEditChart canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()} />;
const table = () => screen.getAllByRole('table')[0]!;

describe('bilingual account names', () => {
  beforeEach(() => window.history.replaceState(null, '', '/?page=accounting'));

  it('prefers the UI language, then the other language, then the legacy name only for accounts with no localized name', () => {
    expect(localizedAccountName({ name: 'L', name_ar: 'ع', name_en: 'E' }, 'ar')).toBe('ع');
    expect(localizedAccountName({ name: 'L', name_ar: null, name_en: 'E' }, 'ar')).toBe('E');
    expect(localizedAccountName({ name: '', name_ar: null, name_en: 'E' }, 'ar')).toBe('E');
    expect(localizedAccountName({ name: 'L', name_ar: 'ع', name_en: 'E' }, 'en')).toBe('E');
    expect(localizedAccountName({ name: 'L', name_ar: 'ع', name_en: null }, 'en')).toBe('ع');
    // stale legacy name (kept as compatibility storage) never beats a real localized name
    expect(localizedAccountName({ name: 'Old', name_ar: null, name_en: 'New' }, 'ar')).toBe('New');
    expect(localizedAccountName({ name: '', name_ar: 'ع' }, 'en')).toBe('ع');
    expect(localizedAccountName({ name: 'L' }, 'ar')).toBe('L');
  });

  it('normalizes valid grouped amounts and rejects malformed or ambiguous separators', () => {
    expect(normalizeFinancialAmount('5,000')).toBe('5000');
    expect(normalizeFinancialAmount('5,000.50')).toBe('5000.50');
    expect(normalizeFinancialAmount('5000.50')).toBe('5000.50');
    expect(normalizeFinancialAmount('50,00')).toBeNull();
    expect(normalizeFinancialAmount('5,000.500')).toBeNull();
    expect(normalizeFinancialAmount('5.000,50')).toBeNull();
  });

  it('uses only the language fields present in legacy endpoint payloads', () => {
    expect(localizedLegacyAccountName({ name: 'Accounts receivable', name_ar: 'الذمم المدينة' }, 'en')).toBe('Accounts receivable');
    expect(localizedLegacyAccountName({ name: 'Accounts receivable', name_ar: 'الذمم المدينة' }, 'ar')).toBe('الذمم المدينة');
  });

  it('shows Arabic names in both accounting tables and the parent column', async () => {
    await i18n.changeLanguage('ar');
    stub();
    render(ui());
    await screen.findAllByText('Legacy Bank');
    expect(within(table()).getByText('النقدية')).toBeInTheDocument();
    expect(within(table()).queryByText('Cash')).not.toBeInTheDocument();
    expect(within(table()).getByText('1000 — النقدية')).toBeInTheDocument();
    const mappingTable = screen.getAllByRole('table').at(-1)!;
    expect(within(mappingTable).getByText('النقدية', { selector: 'td.ac-mapping__name' })).toBeInTheDocument();
    expect(within(mappingTable).queryByText('Cash', { selector: 'td.ac-mapping__name' })).not.toBeInTheDocument();
  });

  it('shows English names in both accounting tables and searches across code, name, name_ar and name_en', async () => {
    await i18n.changeLanguage('en');
    stub();
    render(ui());
    await screen.findAllByText('Legacy Bank');
    expect(within(table()).getByText('Cash')).toBeInTheDocument();
    const mappingTable = screen.getAllByRole('table').at(-1)!;
    expect(within(mappingTable).getByText('Cash', { selector: 'td.ac-mapping__name' })).toBeInTheDocument();
    expect(within(mappingTable).queryByText('النقدية', { selector: 'td.ac-mapping__name' })).not.toBeInTheDocument();
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'النقد' } });
    expect(within(table()).getByText('Cash')).toBeInTheDocument();
    expect(within(table()).queryByText('Legacy Bank')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'legacy' } });
    expect(within(table()).getByText('Legacy Bank')).toBeInTheDocument();
    expect(within(table()).queryByText('Cash')).not.toBeInTheDocument();
  });

  it('creates with only the two localized fields, requires at least one, and localizes the parent selector', async () => {
    await i18n.changeLanguage('en');
    const fetchMock = stub();
    render(ui());
    await screen.findAllByText('Legacy Bank');
    fireEvent.click(screen.getByRole('button', { name: /New account/ }));
    const form = (await screen.findByRole('textbox', { name: 'Code' })).closest('form')!;
    expect(within(form).queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(within(form).getByRole('option', { name: '1000 — Cash' })).toBeInTheDocument();
    expect(within(form).getByRole('textbox', { name: 'Code' })).toHaveValue('');
    expect(within(form).getByRole('textbox', { name: 'Account name (English)' })).toHaveValue('');
    fireEvent.change(within(form).getByRole('textbox', { name: 'Code' }), { target: { value: '1200' } });
    fireEvent.submit(form);
    expect(await within(form).findByRole('alert')).toHaveTextContent('Enter at least the Arabic or the English account name.');
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
    fireEvent.change(within(form).getByRole('textbox', { name: 'Account name (Arabic)' }), { target: { value: 'البنك' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Account name (English)' }), { target: { value: 'Bank' } });
    fireEvent.submit(form);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(true));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([, o]) => o?.method === 'POST')![1]?.body));
    expect(body).toMatchObject({ code: '1200', name_ar: 'البنك', name_en: 'Bank' });
    expect(body).not.toHaveProperty('name');
  });

  it('keeps typed values and shows an inline message when the code already exists', async () => {
    await i18n.changeLanguage('en');
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/accounts' && options?.method === 'POST') return new Response(JSON.stringify({ error: 'Duplicate accounting record' }), { status: 409 });
      if (url === '/api/accounts') return new Response(JSON.stringify({ accounts }));
      if (url.startsWith('/api/account-classifications')) return new Response(JSON.stringify({ accounts: [] }));
      if (url === '/api/fiscal-years') return new Response(JSON.stringify({ fiscalYears: [] }));
      if (url === '/api/journals') return new Response(JSON.stringify({ journals: [] }));
      return new Response(JSON.stringify({ sources: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(ui());
    await screen.findAllByText('Legacy Bank');
    fireEvent.click(screen.getByRole('button', { name: /New account/ }));
    const form = (await screen.findByRole('textbox', { name: 'Code' })).closest('form')!;
    fireEvent.change(within(form).getByRole('textbox', { name: 'Code' }), { target: { value: '1000' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Account name (English)' }), { target: { value: 'Cash 2' } });
    fireEvent.submit(form);
    expect(await within(form).findByRole('alert')).toHaveTextContent('This account code already exists');
    expect(within(form).getByRole('textbox', { name: 'Code' })).toHaveValue('1000');
    expect(within(form).getByRole('textbox', { name: 'Account name (English)' })).toHaveValue('Cash 2');
  });
});
