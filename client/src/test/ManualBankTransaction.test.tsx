import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { BankTransactionsView } from '../components/BankTransactionsView';

const manualTx = { id: 'm1', transaction_date: '2026-03-10', description: 'Cash deposit at branch', bank_reference: null, amount: '500.00', running_balance: null, currency_code: 'SAR', reconciliation_status: 'unmatched', source_kind: 'manual', manual_category: 'other', manual_counterparty: null };
const importedTx = { ...manualTx, id: 'i1', description: 'Imported row', source_kind: 'import', manual_category: null };

function setup(canCreateManual = true, posts: Array<{ url: string; body: any }> = [], postResponse?: () => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) }); return postResponse ? postResponse() : new Response(JSON.stringify({ transaction: { id: 'new' } }), { status: 201 }); }
    if (url === '/api/bank-accounts') return new Response(JSON.stringify({ accounts: [{ id: 'acc-1', display_name: 'Main', is_active: true }] }), { status: 200 });
    if (url === '/api/documents') return new Response(JSON.stringify({ documents: [] }), { status: 200 });
    return new Response(JSON.stringify({ transactions: [manualTx, importedTx] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<MantineProvider><BankTransactionsView canView canMatch canReconcile canCreateManual={canCreateManual} onUnauthorized={vi.fn()}/></MantineProvider>);
  return fetchMock;
}

describe.each(['en', 'ar'] as const)('manual bank transactions (%s)', (lang) => {
  beforeEach(async () => { Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }); await i18n.changeLanguage(lang); vi.restoreAllMocks(); window.history.replaceState(null, '', '/?page=banks&section=transactions'); });
  const L = lang === 'en' ? { add: 'Add bank transaction', manual: 'Manual', save: 'Save transaction', unresolved: /Unresolved for closing until linked/ } : { add: 'إضافة حركة بنكية', manual: 'يدوي', save: 'حفظ الحركة', unresolved: /غير محسومة في الإقفال حتى تُربط/ };

  it('hides the action without permission and marks only manual rows', async () => {
    setup(false);
    await screen.findByText('Imported row');
    expect(screen.queryByRole('button', { name: L.add })).toBeNull();
    expect(document.querySelectorAll('[data-source="manual"]')).toHaveLength(1);
    expect(screen.getByText(L.manual)).toBeInTheDocument();
  });

  it('explains why an other-category manual transaction stays unresolved until linked', async () => {
    setup();
    fireEvent.click((await screen.findByText('Cash deposit at branch')).closest('article')!);
    expect(await screen.findByText(L.unresolved)).toBeInTheDocument();
  });

  it('opens the form, lists inter-account transfer as unavailable, validates, and submits a signed-direction payload', async () => {
    const posts: Array<{ url: string; body: any }> = [];
    setup(true, posts);
    fireEvent.click(await screen.findByRole('button', { name: L.add }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: /Bank account|الحساب البنكي/ })).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole('button', { name: L.save }));
    expect(posts).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('textbox', { name: /Category|التصنيف/ }));
    const names = lang === 'en'
      ? { off: ['Cash deposit', 'Cash withdrawal', 'Incoming transfer', 'Outgoing transfer', 'Inter-account transfer', 'Bank fees', 'Refund'], on: ['Customer receipt', 'Supplier payment', 'Government payment', 'Other'] }
      : { off: ['إيداع نقدي', 'سحب نقدي', 'تحويل وارد', 'تحويل صادر', 'تحويل بين حسابات الشركة', 'رسوم بنكية', 'استرداد'], on: ['تحصيل من عميل', 'سداد لمورد', 'دفعة حكومية', 'أخرى'] };
    for (const name of names.off) expect(await screen.findByRole('option', { name: new RegExp(name), hidden: true }), name).toHaveAttribute('data-combobox-disabled', 'true');
    for (const name of names.on) expect(await screen.findByRole('option', { name: new RegExp(`^${name}$`), hidden: true }), name).not.toHaveAttribute('data-combobox-disabled');
  });

  it('places the add action in its own toolbar row, outside the status banner', async () => {
    setup();
    const button = await screen.findByRole('button', { name: L.add });
    expect(button.closest('.bank-recon__status')).toBeNull();
    expect(button.closest('.bank-recon__actions')).not.toBeNull();
  });

  it('renders the category dropdown above the dialog backdrop and selects a supported category', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: L.add }));
    const dialog = await screen.findByRole('dialog');
    const category = within(dialog).getByRole('textbox', { name: /Category|التصنيف/ });
    fireEvent.click(category);
    const option = await screen.findByRole('option', { name: lang === 'en' ? 'Supplier payment' : 'سداد لمورد', hidden: true });
    const dropdown = option.closest('.mantine-Select-dropdown') as HTMLElement;
    expect(Number(dropdown.style.zIndex)).toBeGreaterThan(1000);
    fireEvent.click(option);
    await waitFor(() => expect(category).toHaveValue(lang === 'en' ? 'Supplier payment' : 'سداد لمورد'));
  });

  it('does not select a deferred category and clears a category that conflicts with a new direction', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: L.add }));
    const dialog = await screen.findByRole('dialog');
    const category = within(dialog).getByRole('textbox', { name: /Category|التصنيف/ });
    fireEvent.click(category);
    fireEvent.click(await screen.findByRole('option', { name: new RegExp(lang === 'en' ? 'Cash deposit' : 'إيداع نقدي'), hidden: true }));
    expect(category).toHaveValue('');
    fireEvent.click(category);
    fireEvent.click(await screen.findByRole('option', { name: lang === 'en' ? 'Customer receipt' : 'تحصيل من عميل', hidden: true }));
    await waitFor(() => expect(category).toHaveValue(lang === 'en' ? 'Customer receipt' : 'تحصيل من عميل'));
    fireEvent.click(within(dialog).getByLabelText(lang === 'en' ? 'Outgoing' : 'صادر'));
    await waitFor(() => expect(category).toHaveValue(''));
  });

  it('surfaces a possible duplicate and only re-submits with explicit confirmation', async () => {
    const posts: Array<{ url: string; body: any }> = [];
    let first = true;
    setup(true, posts, () => { if (first) { first = false; return new Response(JSON.stringify({ error: 'dup', code: 'MANUAL_BANK_POSSIBLE_DUPLICATE', candidates: [{ id: 'abcdef12-0000', source_kind: 'import' }] }), { status: 409 }); } return new Response('{}', { status: 201 }); });
    fireEvent.click(await screen.findByRole('button', { name: L.add }));
    const dialog = await screen.findByRole('dialog');
    const field = (re: RegExp) => within(dialog).getByRole('textbox', { name: re });
    await waitFor(() => expect(field(/Bank account|الحساب البنكي/)).toBeInTheDocument());
    await waitFor(() => expect(field(/Bank account|الحساب البنكي/)).toHaveValue('Main'));
    fireEvent.change(field(/Transaction date|تاريخ الحركة/), { target: { value: '2026-03-10' } });
    fireEvent.click(field(/Category|التصنيف/)); fireEvent.click(await screen.findByRole('option', { name: lang === 'en' ? 'Customer receipt' : 'تحصيل من عميل', hidden: true }));
    fireEvent.change(field(/Amount|المبلغ/), { target: { value: '120.50' } });
    fireEvent.change(field(/Description|البيان/), { target: { value: 'Receipt' } });
    fireEvent.click(within(dialog).getByRole('button', { name: L.save }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe('/api/bank-transactions/manual');
    expect(posts[0]!.body).toMatchObject({ bank_account_id: 'acc-1', transaction_date: '2026-03-10', direction: 'incoming', category: 'customer_receipt', amount: '120.50' });
    expect(posts[0]!.body.confirm_duplicate).toBeUndefined();
    const confirm = await within(dialog).findByRole('button', { name: lang === 'en' ? 'Add anyway' : 'إضافة رغم التشابه' });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body.confirm_duplicate).toBe(true);
  });
});
