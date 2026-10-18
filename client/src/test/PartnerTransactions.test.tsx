import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PartnerTransactions } from '../components/PartnerTransactions';
import i18n from '../i18n';

const partners = [{ id: 'p1', name: 'Partner A', is_active: true }, { id: 'p2', name: 'Partner B', is_active: true }];
const draftTx = { id: 't1', partner_id: 'p1', partner_name: 'Partner A', transaction_type: 'current_withdrawal', transaction_date: '2026-03-10', amount: '1500.00', channel: 'cash', bank_account_id: null,
  bank_transaction_id: null, document_id: null, reference: null, description: null, status: 'draft', journal_entry_id: null, reversal_date: null, reversal_reason: null, version: 1 };
const postedTx = { ...draftTx, id: 't2', status: 'posted', journal_entry_id: 'j1', version: 2 };
const balances = { as_of: '2026-10-18', partners: [{ partner_id: 'p1', partner_name: 'Partner A', capital: '58000.00', current: '-2000.00', loan: '1500.00' }] };
const mappings = { partner_mappings: [], cash_mappings: [], bank_accounts: [{ id: 'b1', display_name: 'Main', currency_code: 'SAR', is_active: true }],
  accounts: [{ id: 'a1', code: '3100', name: 'Partner A capital', account_type: 'equity' }, { id: 'a2', code: '1100', name: 'Cash', account_type: 'asset' }, { id: 'a3', code: '2300', name: 'Loan', account_type: 'liability' }] };
const ledger = { classes: { capital: { opening_balance: '50000.00', increases: '8000.00', decreases: '0.00', closing_balance: '58000.00' },
  current: { opening_balance: '-3000.00', increases: '1400.00', decreases: '400.00', closing_balance: '-2000.00' }, loan: { opening_balance: '0.00', increases: '2000.00', decreases: '500.00', closing_balance: '1500.00' } },
  movements: [{ date: '2026-02-01', kind: 'transaction', account_class: 'current', transaction_type: 'current_deposit', effect: '1000.00', running_balance: '-2000.00', reference: 'R1', description: null }], draft_transactions_excluded: 1 };

const ALL = ['partner.transaction.view', 'partner.transaction.create', 'partner.transaction.post', 'partner.transaction.reverse', 'partner.account_mapping.manage'];
function stubFetch(txs: unknown[], extra: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url in extra) return extra[url] as Response;
    if (init?.method === 'PUT' || init?.method === 'DELETE' && url.includes('account-mappings')) return new Response(JSON.stringify(mappings));
    if (url.startsWith('/api/partners/transactions') && !init?.method) return new Response(JSON.stringify({ transactions: txs }));
    if (url.startsWith('/api/partners/balances')) return new Response(JSON.stringify(balances));
    if (url === '/api/partners/account-mappings') return new Response(JSON.stringify(mappings));
    if (url.includes('/ledger')) return new Response(JSON.stringify(ledger));
    if (url.includes('/post') || url.includes('/reverse')) return new Response(JSON.stringify({}));
    return new Response(JSON.stringify({ transactions: [] }));
  }));
  return calls;
}
const renderIt = (caps: string[], selected: string | null = 'p1') => render(<PartnerTransactions partners={partners} selectedPartnerId={selected} capabilities={caps} onUnauthorized={vi.fn()} />);

describe('PartnerTransactions', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders nothing and makes no request without the view capability', () => {
    const calls = stubFetch([]);
    const { container } = renderIt(['partner.view']);
    expect(container).toBeEmptyDOMElement();
    expect(calls).toHaveLength(0);
  });

  it('lists transactions with balances and shows actions only for the capabilities held', async () => {
    stubFetch([draftTx, postedTx]);
    renderIt(['partner.transaction.view']);
    expect(await screen.findAllByText('Withdrawal (current account)')).toHaveLength(2);
    expect(screen.getByTestId('partner-balances')).toHaveTextContent('58000.00');
    expect(screen.queryByRole('button', { name: 'Post' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New transaction' })).not.toBeInTheDocument();
  });

  it('posts a draft and reverses a posted transaction through the dedicated endpoints', async () => {
    const calls = stubFetch([draftTx, postedTx]);
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('button', { name: 'Post' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/partners/transactions/t1/post' && c.init?.method === 'POST')).toBe(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Reverse' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Correction reason'), { target: { value: 'entered twice' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reverse' }));
    await waitFor(() => {
      const call = calls.find((c) => c.url === '/api/partners/transactions/t2/reverse');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call!.init!.body))).toMatchObject({ reason: 'entered twice' });
    });
  });

  it('creates a draft with the typed fields and explains that a withdrawal is not a distribution', async () => {
    const calls = stubFetch([]);
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('button', { name: 'New transaction' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/not a profit distribution or a capital reduction/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Amount (SAR)'), { target: { value: '250.50' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const call = calls.find((c) => c.url === '/api/partners/transactions' && c.init?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call!.init!.body))).toMatchObject({ partner_id: 'p1', transaction_type: 'current_withdrawal', amount: '250.50', channel: 'cash', bank_account_id: null });
    });
  });

  it('shows a localized message for a server refusal inside the dialog and keeps it open', async () => {
    stubFetch([]);
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('button', { name: 'New transaction' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Amount (SAR)'), { target: { value: '10' } });
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => new Response(JSON.stringify({ code: 'PARTNER_PERIOD_CLOSED' }), { status: 409 }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The accounting month of this date is closed.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the ledger summary per class with opening and closing balances and the excluded-drafts note', async () => {
    stubFetch([]);
    renderIt(['partner.transaction.view']);
    fireEvent.click(await screen.findByRole('tab', { name: 'Partner ledger' }));
    const capital = await screen.findByTestId('ledger-class-capital');
    expect(capital).toHaveTextContent('50000.00');
    expect(capital).toHaveTextContent('58000.00');
    expect(screen.getByTestId('ledger-class-current')).toHaveTextContent('-2000.00');
    expect(screen.getByText('1 draft transaction(s) are not included until posted.')).toBeInTheDocument();
    expect(screen.getByText('Current-account deposit')).toBeInTheDocument();
  });

  it('lets only mapping managers change accounts and filters the picker by allowed type', async () => {
    const calls = stubFetch([]);
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('tab', { name: 'Account mapping' }));
    const group = (await screen.findByText('Partner A')).closest('fieldset')!;
    const capitalSelect = within(group).getByText('Capital account').closest('label')!.querySelector('select')!;
    const options = Array.from(capitalSelect.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('3100 — Partner A capital');
    expect(options).not.toContain('1100 — Cash');
    expect(options).not.toContain('2300 — Loan');
    fireEvent.change(capitalSelect, { target: { value: 'a1' } });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/partners/p1/account-mappings/capital' && c.init?.method === 'PUT')).toBe(true));
  });

  it('renders Arabic labels with right-to-left safe numbers', async () => {
    await i18n.changeLanguage('ar');
    stubFetch([draftTx]);
    renderIt(['partner.transaction.view']);
    expect(await screen.findByText('المعاملات المالية للشركاء')).toBeInTheDocument();
    expect(screen.getByText('سحب (من الحساب الجاري)')).toBeInTheDocument();
    for (const amount of screen.getAllByText('1500.00')) expect(amount).toHaveAttribute('dir', 'ltr');
    expect(screen.getByRole('tab', { name: 'كشف الشريك' })).toBeInTheDocument();
  });
});
