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

const stub = () => {
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === `/api/accounts/${accounts[0]!.id}` && options?.method === 'PATCH') return new Response(JSON.stringify({ ...accounts[0], is_active: false }));
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts }));
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

  it('shows identity fields read-only and only sends is_active when the status changes', async () => {
    const fetchMock = stub();
    render(ui());
    await screen.findByText('Bank');
    const panel = screen.getByRole('complementary');
    for (const field of within(panel).getAllByRole('textbox')) expect(field).toBeDisabled();
    expect(within(panel).getAllByRole('combobox').slice(0, 2).every((el) => (el as HTMLSelectElement).disabled)).toBe(true);
    const update = within(panel).getByRole('button', { name: 'Update account' });
    expect(update).toBeDisabled();
    fireEvent.change(within(panel).getAllByRole('combobox')[2]!, { target: { value: 'inactive' } });
    expect(update).toBeEnabled();
    fireEvent.click(update);
    await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find(([, o]) => o?.method === 'PATCH')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ is_active: false });
  });

  it('keeps the status control disabled without the edit capability', async () => {
    stub();
    render(ui(false));
    await screen.findByText('Bank');
    const panel = screen.getByRole('complementary');
    expect(within(panel).getAllByRole('combobox')[2]).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Update account' })).toBeDisabled();
  });
  it('drops an unsaved status draft when the shown account changes', async () => {
    stub();
    render(ui());
    await screen.findByText('Bank');
    const panel = screen.getByRole('complementary');
    fireEvent.change(within(panel).getAllByRole('combobox')[2]!, { target: { value: 'inactive' } });
    expect(within(panel).getByRole('button', { name: 'Update account' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(within(panel).getAllByRole('combobox')[2]).toHaveValue('active');
    expect(within(panel).getByRole('button', { name: 'Update account' })).toBeDisabled();
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
