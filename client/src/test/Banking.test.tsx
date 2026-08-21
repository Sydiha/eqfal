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
    expect((await screen.findAllByText('Main')).length).toBeGreaterThan(0);
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

  it('shows auto-generated preview immediately after a confidently mapped upload',async()=>{
    const account={id:'a1',display_name:'Main',bank_name:'Bank',currency_code:'SAR',is_active:true};
    const batch={id:'batch-auto',bank_account_id:'a1',original_filename:'eqfal_sales_e2e_1150.csv',status:'preview_ready',total_rows:1,valid_rows:1,duplicate_rows:0,invalid_rows:0,created_at:'2026-08-21T00:00:00.000Z'};
    const mapping={
      amount_mode:'signed',
      date_format:'MM/DD/YYYY',
      transaction_date:{index:0,label:'date'},
      amount:{index:3,label:'amount'},
      description:{index:1,label:'description'},
      bank_reference:{index:2,label:'reference'},
    };
    const preview={
      totalRows:1,
      validRows:1,
      duplicateRows:0,
      possibleDuplicateRows:0,
      invalidRows:0,
      rows:[{
        source_row_number:2,
        transaction_date:'2026-08-21',
        description:'EQFAL sales E2E test',
        bank_reference:'E2E-SALE-1150-001',
        amount:'1150.00',
        running_balance:null,
        status:'valid',
        error:null,
      }],
    };

    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({accounts:[account]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({batches:[]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({transactions:[]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        batch,
        columns:['date','description','reference','amount'],
        mapping,
        preview,
        autoMapped:true,
      }),{status:201}))
      .mockResolvedValueOnce(new Response(JSON.stringify({accounts:[account]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({batches:[batch]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({transactions:[]}),{status:200}));

    vi.stubGlobal('fetch',fetchMock);
    renderBanking({ canView:true, canImport:true, canManage:false, canMatch:false, canReconcile:false, onUnauthorized:vi.fn() });

    expect((await screen.findAllByText('Main')).length).toBeGreaterThan(0);

    const fileInput=document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    const file=new File(
      ['date,description,reference,amount\n8/21/2026,EQFAL sales E2E test,E2E-SALE-1150-001,1150'],
      'eqfal_sales_e2e_1150.csv',
      {type:'text/csv'},
    );

    fireEvent.change(fileInput,{target:{files:[file]}});

    const uploadButton=screen.getByRole('button',{name:/Upload/i});
    await waitFor(()=>expect(uploadButton).toBeEnabled());
    fireEvent.click(uploadButton);

    await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(7));

    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/bank-import-batches');
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({method:'POST'});

    expect(await screen.findByText('EQFAL sales E2E test')).toBeInTheDocument();
    expect(screen.getByText('E2E-SALE-1150-001')).toBeInTheDocument();
    expect(screen.getByText('1150.00')).toBeInTheDocument();
    expect(screen.getByRole('textbox',{name:/Date format/i})).toHaveValue('MM/DD/YYYY');
  });

  it('resumes preview-ready imports with saved mapping and preview restored',async()=>{
    const previewReady={id:'batch-preview',bank_account_id:'a1',original_filename:'phase4c-settlement-test.csv',status:'preview_ready',total_rows:1,valid_rows:1,duplicate_rows:0,invalid_rows:0,created_at:'2026-08-18T00:00:00.000Z'};
    const confirmed={...previewReady,id:'batch-confirmed',original_filename:'confirmed.csv',status:'confirmed'};
    const mapping={
      amount_mode:'signed',
      date_format:'MM/DD/YYYY',
      transaction_date:{index:0,label:'date'},
      amount:{index:3,label:'amount'},
      description:{index:1,label:'description'},
      bank_reference:{index:2,label:'reference'},
    };
    const preview={
      totalRows:1,
      validRows:1,
      duplicateRows:0,
      possibleDuplicateRows:0,
      invalidRows:0,
      rows:[{
        source_row_number:2,
        transaction_date:'2026-08-21',
        description:'EQFAL sales E2E test',
        bank_reference:'E2E-SALE-1150-001',
        amount:'1150.00',
        running_balance:null,
        status:'valid',
        error:null,
      }],
    };
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({accounts:[{id:'a1',display_name:'Main',bank_name:'Bank',currency_code:'SAR',is_active:true}]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({batches:[previewReady,confirmed]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({transactions:[]}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        batch:previewReady,
        columns:['date','description','reference','amount'],
        mapping,
        preview,
      }),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    Object.defineProperty(window.HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
    renderBanking({ canView:true, canImport:true, canManage:false, canMatch:false, canReconcile:false, onUnauthorized:vi.fn() });

    expect(await screen.findByText('phase4c-settlement-test.csv')).toBeInTheDocument();
    expect(screen.getAllByRole('button',{name:'Resume'})).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'Resume'}));

    await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/bank-import-batches/batch-preview/resume');
    expect(fetchMock.mock.calls[3]?.[1]).toBeUndefined();

    expect(await screen.findByText('EQFAL sales E2E test')).toBeInTheDocument();
    expect(screen.getByText('E2E-SALE-1150-001')).toBeInTheDocument();
    expect(screen.getByText('1150.00')).toBeInTheDocument();
    expect(screen.getByRole('textbox',{name:/Date format/i})).toHaveValue('MM/DD/YYYY');
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
});
