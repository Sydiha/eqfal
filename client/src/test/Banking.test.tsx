import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { Banking } from '../components/Banking';

beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});

function renderBanking(props: React.ComponentProps<typeof Banking>) {
  return render(<MantineProvider><Banking {...props}/></MantineProvider>);
}

describe('Banking',()=>{
  it('does not request banking data without bank.view',()=>{
    vi.stubGlobal('fetch',vi.fn());
    renderBanking({ canView:false, canImport:true, canManage:true, canMatch:true, canReconcile:true, onUnauthorized:vi.fn() });
    expect(screen.getByText(/do not have permission/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads company-scoped accounts, batches, and transactions and respects capability presentation',async()=>{
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({accounts:[{id:'a1',display_name:'Main',bank_name:'Bank',currency_code:'SAR',is_active:true}]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({batches:[]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({transactions:[]}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    renderBanking({ canView:true, canImport:false, canManage:false, canMatch:false, canReconcile:false, onUnauthorized:vi.fn() });
    expect(await screen.findByText('Main')).toBeInTheDocument();
    expect(screen.queryByText('Create account')).not.toBeInTheDocument();
    expect(screen.queryByText('Import statement')).not.toBeInTheDocument();
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(call=>call[0])).toEqual(['/api/bank-accounts','/api/bank-import-batches','/api/bank-transactions']);
  });

  it('resets the bank account form after a successful create without surfacing an error',async()=>{
    const created={id:'a1',display_name:'Validation account',bank_name:'Test Bank',currency_code:'SAR',is_active:true};
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({accounts:[]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({batches:[]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({transactions:[]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({account:created}),{status:201}))
      .mockResolvedValueOnce(new Response(JSON.stringify({accounts:[created]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({batches:[]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({transactions:[]}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    renderBanking({ canView:true, canImport:false, canManage:true, canMatch:false, canReconcile:false, onUnauthorized:vi.fn() });

    const accountName=await screen.findByRole('textbox',{name:/Account name/i});
    const bankName=screen.getByRole('textbox',{name:/Bank name/i});
    const currency=screen.getByRole('textbox',{name:/Currency/i});
    fireEvent.change(accountName,{target:{value:'Validation account'}});
    fireEvent.change(bankName,{target:{value:'Test Bank'}});
    fireEvent.change(currency,{target:{value:'USD'}});
    fireEvent.click(screen.getByRole('button',{name:'Create account'}));

    await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(7));
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/bank-accounts');
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({method:'POST'});
    expect(accountName).toHaveValue('');
    expect(bankName).toHaveValue('');
    expect(currency).toHaveValue('SAR');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await screen.findByText('Validation account')).toBeInTheDocument();
  });

  it('shows matching action only when bank.match is granted',async()=>{
    const transaction={id:'11111111-1111-4111-8111-111111111111',transaction_date:'2026-08-01',description:'Vendor',bank_reference:'R1',amount:'-100.00',running_balance:'900.00',currency_code:'SAR',reconciliation_status:'unmatched'};
    const responses=[{accounts:[]},{batches:[]},{transactions:[transaction]}];
    vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify(responses.shift()),{status:200}))));
    const {rerender}=renderBanking({ canView:true, canImport:false, canManage:false, canMatch:false, canReconcile:false, onUnauthorized:vi.fn() });
    expect(await screen.findByText('Unmatched')).toBeInTheDocument();
    expect(screen.queryByText('Match')).not.toBeInTheDocument();
    rerender(<MantineProvider><Banking canView canImport={false} canManage={false} canMatch canReconcile={false} onUnauthorized={vi.fn()}/></MantineProvider>);
    expect(await screen.findByText('Match')).toBeInTheDocument();
  });

  it('keeps long transaction descriptions accessible while constraining their table cell',async()=>{
    const description='Name-1: AHMADSALMAN PULLUMKATTLE SIDDICK / Name-2: AHMADSALMAN PULLUMKA / CA: 106000010006086518378';
    const reference='LONG-BANK-REFERENCE-1234567890';
    const transaction={id:'22222222-2222-4222-8222-222222222222',transaction_date:'2025-07-21',description,bank_reference:reference,amount:'-200.00',running_balance:'1250.00',currency_code:'SAR',reconciliation_status:'unmatched'};
    const responses=[{accounts:[]},{batches:[]},{transactions:[transaction]}];
    vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>Promise.resolve(new Response(JSON.stringify(responses.shift()),{status:200}))));

    renderBanking({ canView:true, canImport:false, canManage:false, canMatch:false, canReconcile:false, onUnauthorized:vi.fn() });

    const descriptionNode=await screen.findByTitle(description);
    const referenceNode=screen.getByTitle(reference);
    expect(descriptionNode).toHaveClass('bank-tx-description-text');
    expect(referenceNode).toHaveClass('bank-tx-reference-text');
    expect(descriptionNode.closest('td')).toHaveClass('bank-tx-description');
    expect(referenceNode.closest('td')).toHaveClass('bank-tx-reference');
  });
});
