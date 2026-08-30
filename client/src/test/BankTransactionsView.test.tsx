import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { BankTransactionsView } from '../components/BankTransactionsView';

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/?page=banks&section=transactions');
});

const transactions = [
  {id:'tx-old',transaction_date:'2026-08-01',description:'Vendor payment بيان',bank_reference:'BANK-NEG',amount:'-350.00',running_balance:'12500.00',currency_code:'SAR',reconciliation_status:'unmatched'},
  {id:'tx-new',transaction_date:'2026-08-20',description:'Customer receipt',bank_reference:'BANK-POS',amount:'1150.00',running_balance:null,currency_code:'SAR',reconciliation_status:'matched'},
  {id:'tx-mid',transaction_date:'2026-08-16',description:'Monthly fee',bank_reference:null,amount:'-20.00',running_balance:'13650.00',currency_code:'SAR',reconciliation_status:'reconciled'},
] as const;

function renderTransactions(data: readonly object[] = transactions) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ transactions: data }), { status: 200 })));
  return render(<MantineProvider><BankTransactionsView canView canMatch canReconcile onUnauthorized={vi.fn()}/></MantineProvider>);
}

describe('BankTransactionsView', () => {
  it('shows document identity and linked obligation integrity context in the match dialog', async () => {
    const transaction={id:'11111111-1111-4111-8111-111111111111',transaction_date:'2026-08-16',description:'Customer receipt',bank_reference:null,amount:'1150.00',running_balance:null,currency_code:'SAR',reconciliation_status:'unmatched'};
    const candidate={id:'doc-a',status:'approved',document_type:'sale',counterparty_name:'Customer A with a complete counterparty name',document_date:'2026-08-01',reference_number:'SALE-A',total_amount:'1234567890.00',original_filename:'same.pdf',linked_obligation:{id:'obligation-a',direction:'receivable',counterparty:'Customer A',original_amount:'1150.00',settled_amount:'150.00',remaining_amount:'1000.00',state:'partial'}};
    const fetchMock=vi.fn(async(url:string,init?:RequestInit)=>new Response(JSON.stringify(init?.method==='POST'?{}:url.includes('match-candidates')?{transaction,match:null,documents:[candidate]}:{transactions:[transaction]}),{status:200}));vi.stubGlobal('fetch',fetchMock);
    render(<MantineProvider><BankTransactionsView canView canMatch canReconcile onUnauthorized={vi.fn()}/></MantineProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'Match'}));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Sale')).toBeInTheDocument();expect(screen.getByText('Customer A with a complete counterparty name')).toBeInTheDocument();expect(screen.getByText('1234567890.00')).toBeInTheDocument();expect(screen.getByText('partial')).toBeInTheDocument();expect(screen.getByText(/Remaining amount:/)).toHaveTextContent('1000.00');expect(screen.getByText('SALE-A')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox',{name:'Search documents'}),{target:{value:'SALE-A'}});
    fireEvent.click(screen.getByRole('button',{name:'Search'}));
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(`/api/bank-transactions/${transaction.id}/match-candidates?search=SALE-A`,undefined));

    const confirm=screen.getByRole('button',{name:'Confirm match'});
    expect(confirm).toBeDisabled();
    const documentRow=screen.getByRole('button',{name:/Sale.*Customer A with a complete counterparty name.*1234567890\.00/s});
    expect(documentRow).toHaveAttribute('aria-pressed','false');
    fireEvent.click(documentRow);
    expect(documentRow).toHaveAttribute('aria-pressed','true');
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(`/api/bank-transactions/${transaction.id}/match`,expect.objectContaining({method:'POST',body:JSON.stringify({document_id:'doc-a'})})));
  });
  it('renders a focused five-column operating view with bank metadata kept secondary', async () => {
    const transaction = {
      id: '11111111-1111-4111-8111-111111111111',
      transaction_date: '2026-08-16T00:00:00.000Z',
      description: 'Vendor payment with mixed بيان عربي',
      bank_reference: 'BANK-REF-001',
      amount: '-350.00',
      running_balance: '12500.00',
      currency_code: 'SAR',
      reconciliation_status: 'unmatched',
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ transactions: [transaction] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<MantineProvider><BankTransactionsView canView canMatch canReconcile onUnauthorized={vi.fn()}/></MantineProvider>);

    expect(await screen.findByText('Vendor payment with mixed بيان عربي')).toBeInTheDocument();
    expect(screen.getByText('16/08/2026')).toBeInTheDocument();
    expect(screen.getByText('-350.00 SAR')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Match' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument();
    expect(screen.getByText('BANK-REF-001')).toBeInTheDocument();
    expect(screen.queryByText('12500.00 SAR')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/bank-transactions', undefined));
  });

  it('searches description, reference, amount, and running balance with trimmed multilingual text', async () => {
    renderTransactions();
    const search = await screen.findByRole('searchbox', { name: 'Search transactions' });
    fireEvent.change(search, { target: { value: '  بيان  ' } });
    expect(screen.getByText('Vendor payment بيان')).toBeInTheDocument();
    expect(screen.queryByText('Customer receipt')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'bank-pos' } });
    expect(screen.getByText('Customer receipt')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '13650' } });
    expect(screen.getByText('Monthly fee')).toBeInTheDocument();
  });

  it('applies reconciliation, inclusive dates, signed amount ranges, and combined filters', async () => {
    renderTransactions();
    await screen.findByText('Customer receipt');
    fireEvent.change(screen.getByRole('combobox', { name: 'Reconciliation status' }), { target: { value: 'unmatched' } });
    expect(screen.getByText('Vendor payment بيان')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('Minimum amount'), { target: { value: '-350' } });
    fireEvent.change(screen.getByLabelText('Maximum amount'), { target: { value: '-350' } });
    expect(screen.getByText('Vendor payment بيان')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('1 results');
  });

  it('initializes safely from URL, restores history, clears only discovery state, and reports zero results', async () => {
    window.history.replaceState(null, '', '/?page=banks&section=transactions&search=receipt&reconciliation=bad&from=not-a-date&amountMin=nope&safe=keep');
    renderTransactions();
    expect(await screen.findByText('Customer receipt')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Reconciliation status' })).toHaveValue('');
    expect(screen.getByLabelText('From date')).toHaveValue('');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search transactions' }), { target: { value: 'missing' } });
    expect(screen.getByText('0 results')).toBeInTheDocument();
    expect(screen.getByText('No transactions match the filters.').closest('[data-state]')).toHaveAttribute('data-state', 'no-results');
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    expect(window.location.search).toContain('page=banks');
    expect(window.location.search).toContain('section=transactions');
    expect(window.location.search).toContain('safe=keep');
    expect(window.location.search).not.toContain('search=');
    act(() => { window.history.pushState(null, '', '/?page=banks&section=transactions&reconciliation=reconciled'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(screen.getByText('Monthly fee')).toBeInTheDocument();
    expect(screen.queryByText('Customer receipt')).not.toBeInTheDocument();
  });

  it('distinguishes genuine empty data and preserves deterministic date-descending stable ordering', async () => {
    const { unmount } = renderTransactions([]);
    expect((await screen.findByText('No bank transactions')).closest('[data-state]')).toHaveAttribute('data-state', 'empty');
    unmount();
    renderTransactions([transactions[0], { ...transactions[2], id: 'same-a', transaction_date: '2026-08-20', description: 'Stable first' }, { ...transactions[2], id: 'same-b', transaction_date: '2026-08-20', description: 'Stable second' }, transactions[1]]);
    const rows = await screen.findAllByRole('article');
    expect(rows.map(row => within(row).getByText(/Customer receipt|Stable first|Stable second|Vendor payment/).textContent)).toEqual(['Stable first', 'Stable second', 'Customer receipt', 'Vendor payment بيان']);
  });

  it('keeps the match dialog operational while the list is filtered and returns to that filter', async () => {
    const transaction = transactions[0];
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('match-candidates') ? { transaction, match: null, documents: [] } : { transactions }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MantineProvider><BankTransactionsView canView canMatch canReconcile onUnauthorized={vi.fn()}/></MantineProvider>);
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search transactions' }), { target: { value: 'BANK-NEG' } });
    fireEvent.click(screen.getByRole('button', { name: 'Match' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search transactions' })).toHaveValue('BANK-NEG');
    expect(screen.getByText('Vendor payment بيان')).toBeInTheDocument();
  });
});
