import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { Accounting } from '../components/Accounting';

const accounts = Array.from({ length: 7 }, (_, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i + 1}`,
  code: String(1000 + i * 100),
  name: i === 0 ? 'Bank' : `Account ${i}`,
  account_type: (i < 5 ? 'asset' : 'expense') as 'asset' | 'expense',
  parent_account_id: null,
  is_active: true,
}));

const stub = (used = false, extra: Record<string, unknown> = {}, patchStatus = 200) => {
  const list = accounts.map((a, i) => (i === 0 ? { ...a, is_used: used, ...extra } : a));
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === `/api/accounts/${accounts[0]!.id}` && options?.method === 'PATCH') return new Response(JSON.stringify(patchStatus === 200 ? { ...list[0], is_active: false } : { error: 'Account field is locked: code' }), { status: patchStatus });
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts: list }));
    if (url.startsWith('/api/account-classifications')) return new Response(JSON.stringify({ accounts: [] }));
    if (url === '/api/fiscal-years') return new Response(JSON.stringify({ fiscalYears: [] }));
    if (url === '/api/journals') return new Response(JSON.stringify({ journals: [] }));
    return new Response(JSON.stringify({ sources: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const ui = (canEdit = true) => <Accounting canView canCreateChart canEditChart={canEdit} canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()} />;

describe('Accounting chart-of-accounts workspace', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); window.history.replaceState(null, '', '/?page=accounting'); });

  it('pages and filters the loaded accounts without extra requests', async () => {
    const fetchMock = stub();
    render(ui());
    expect(await screen.findByText('Bank')).toBeInTheDocument();
    expect(screen.queryByText('Account 6')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1–5 of 7 accounts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(screen.getByText('Account 6')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bank' } });
    expect(screen.getByText('Showing 1–1 of 1 accounts')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/accounts')).toHaveLength(1);
  });

  const openEdit = async (canEdit = true) => {
    render(ui(canEdit));
    await screen.findByText('Bank');
    const panel = screen.getByRole('complementary');
    return panel;
  };
  const patches = (fetchMock: ReturnType<typeof stub>) => fetchMock.mock.calls.filter(([, o]) => o?.method === 'PATCH');

  it('shows the account read-only until Edit is pressed and hides Edit without the capability', async () => {
    stub();
    const panel = await openEdit();
    for (const field of within(panel).getAllByRole('textbox')) expect(field).toBeDisabled();
    for (const field of within(panel).getAllByRole('combobox')) expect(field).toBeDisabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
    expect(within(panel).getAllByRole('textbox').every((el) => !(el as HTMLInputElement).disabled)).toBe(true);
    expect(within(panel).getByRole('button', { name: 'Save changes' })).toBeEnabled();
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(within(panel).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('hides Edit without the edit capability', async () => {
    stub();
    const panel = await openEdit(false);
    expect(within(panel).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('sends only the changed fields for an unused account', async () => {
    const fetchMock = stub();
    const panel = await openEdit();
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
    const [code, name] = within(panel).getAllByRole('textbox');
    fireEvent.change(code!, { target: { value: '1999' } });
    fireEvent.change(name!, { target: { value: 'Main bank' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(patches(fetchMock)[0]![1]?.body))).toEqual({ code: '1999', name_ar: 'Main bank' });
  });

  it('locks code, type and parent for a used account but still allows name and status', async () => {
    const fetchMock = stub(true);
    const panel = await openEdit();
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
    const [code, name] = within(panel).getAllByRole('textbox');
    const [type, parent, status] = within(panel).getAllByRole('combobox');
    expect(code).toBeDisabled();
    expect(type).toBeDisabled();
    expect(parent).toBeDisabled();
    expect(name).toBeEnabled();
    expect(status).toBeEnabled();
    expect(within(panel).getByText(/Code is locked/)).toBeInTheDocument();
    expect(within(panel).getByText(/Type is locked/)).toBeInTheDocument();
    expect(within(panel).getByText(/Parent is locked/)).toBeInTheDocument();
    fireEvent.change(name!, { target: { value: 'Renamed' } });
    fireEvent.change(status!, { target: { value: 'inactive' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(patches(fetchMock)[0]![1]?.body))).toEqual({ name_ar: 'Renamed', is_active: false });
  });

  it('locks the type when the account has child accounts', async () => {
    stub(false, { has_children: true });
    const panel = await openEdit();
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
    expect(within(panel).getAllByRole('combobox')[0]).toBeDisabled();
    expect(within(panel).getAllByRole('textbox')[0]).toBeEnabled();
  });

  it('explains a server-side lock conflict and refreshes the data', async () => {
    const fetchMock = stub(false, {}, 409);
    const panel = await openEdit();
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(panel).getAllByRole('textbox')[0]!, { target: { value: '1999' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Could not save/)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/accounts')).toHaveLength(2));
  });

  it('drops an unsaved draft when the shown account changes', async () => {
    stub();
    const panel = await openEdit();
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(panel).getAllByRole('textbox')[1]!, { target: { value: 'Draft' } });
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(within(panel).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(panel).queryByDisplayValue('Draft')).not.toBeInTheDocument();
  });

  it('renders the edit flow in Arabic', async () => {
    await i18n.changeLanguage('ar');
    stub();
    const panel = await openEdit();
    fireEvent.click(within(panel).getByRole('button', { name: 'تعديل' }));
    expect(within(panel).getByRole('button', { name: 'حفظ التعديلات' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'إلغاء' })).toBeInTheDocument();
  });

  it('mirrors pager arrows in Arabic', async () => {
    await i18n.changeLanguage('ar');
    stub();
    render(ui());
    await screen.findByText('Bank');
    expect(screen.getByRole('button', { name: 'الصفحة السابقة' })).toHaveTextContent('›');
    expect(screen.getByRole('button', { name: 'الصفحة التالية' })).toHaveTextContent('‹');
  });
});
