import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { SettlementPanel } from '../components/SettlementPanel';

beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});

function renderPanel(props:React.ComponentProps<typeof SettlementPanel>){return render(<MantineProvider><SettlementPanel {...props}/></MantineProvider>);}

describe('SettlementPanel',()=>{
  it('does not request data without bank.view',()=>{
    vi.stubGlobal('fetch',vi.fn());
    renderPanel({canView:false,canSettle:true,onUnauthorized:vi.fn()});
    expect(screen.queryByText('Payment settlements')).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads matched bank transactions while keeping mutation controls hidden without payment.settle',async()=>{
    const tx={id:'11111111-1111-4111-8111-111111111111',transaction_date:'2026-08-01',description:'Vendor',bank_reference:'R1',amount:'-40.00',reconciliation_status:'matched'};
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({transactions:[tx]}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    renderPanel({canView:true,canSettle:false,onUnauthorized:vi.fn()});
    expect(screen.getByText('Payment settlements')).toBeInTheDocument();
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Record settlement')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete settlement')).not.toBeInTheDocument();
  });

  const TX='11111111-1111-4111-8111-111111111111';
  const DA='22222222-2222-4222-8222-222222222222';
  const DB='33333333-3333-4333-8333-333333333333';
  const candidates=(allocated:string,unallocated:string)=>({transaction:{id:TX,amount:'1000.00',reconciliation_status:'unmatched'},match:null,matches:[],allocated_amount:allocated,unallocated_amount:unallocated,documents:[
    {id:DA,status:'approved',counterparty_name:'Customer A',document_date:'2026-01-10',reference_number:null,total_amount:'600.00',original_filename:'a.pdf',linked_obligation:null},
    {id:DB,status:'approved',counterparty_name:'Customer A',document_date:'2026-01-11',reference_number:null,total_amount:'400.00',original_filename:'b.pdf',linked_obligation:null},
    {id:'44444444-4444-4444-8444-444444444444',status:'needs_review',counterparty_name:'Customer A',document_date:null,reference_number:null,total_amount:'50.00',original_filename:'draft.pdf',linked_obligation:null}]});

  it.each(['en','ar'] as const)('allocates one bank transaction to several documents in one request (%s)',async(lang)=>{
    await i18n.changeLanguage(lang);
    const tx={id:TX,transaction_date:'2026-01-20',description:'Receipt',bank_reference:'R1',amount:'1000.00',reconciliation_status:'unmatched'};
    const fetchMock=vi.fn(async(url:string,init?:RequestInit)=>{
      if(url==='/api/bank-transactions')return new Response(JSON.stringify({transactions:[tx]}),{status:200});
      if(url.endsWith('/match-candidates'))return new Response(JSON.stringify(fetchMock.mock.calls.some(c=>String(c[0]).endsWith('/allocations'))?candidates('1000.00','0.00'):candidates('0.00','1000.00')),{status:200});
      if(url.endsWith('/allocations')&&init?.method==='POST')return new Response(JSON.stringify({status:'matched'}),{status:201});
      return new Response('{}',{status:404});
    });
    vi.stubGlobal('fetch',fetchMock);
    const labels=lang==='ar'?{tx:'الحركة البنكية المطابقة',amount:'مبلغ التسوية',save:'حفظ التوزيع',unallocated:'غير الموزع'}:{tx:'Matched bank transaction',amount:'Settlement amount',save:'Save allocations',unallocated:'Unallocated'};
    renderPanel({canView:true,canSettle:true,onUnauthorized:vi.fn()});
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByLabelText(labels.tx)[0]!);
    fireEvent.click(await screen.findByText(/Receipt/));
    expect(await screen.findByText(labels.unallocated)).toBeInTheDocument();
    expect(screen.queryByText('draft.pdf')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(`${labels.amount} a.pdf`),{target:{value:'600'}});
    fireEvent.change(screen.getByLabelText(`${labels.amount} b.pdf`),{target:{value:'400'}});
    const save=screen.getByRole('button',{name:labels.save});
    await waitFor(()=>expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(`/api/bank-transactions/${TX}/allocations`,expect.objectContaining({method:'POST'})));
    const call=fetchMock.mock.calls.find(c=>String(c[0]).endsWith('/allocations'))!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({allocations:[{document_id:DA,amount:'600.00'},{document_id:DB,amount:'400.00'}]});
  });

  it('blocks an allocation above the unallocated amount',async()=>{
    const tx={id:TX,transaction_date:'2026-01-20',description:'Receipt',bank_reference:'R1',amount:'1000.00',reconciliation_status:'unmatched'};
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url==='/api/bank-transactions'?new Response(JSON.stringify({transactions:[tx]}),{status:200}):new Response(JSON.stringify(candidates('900.00','100.00')),{status:200})));
    renderPanel({canView:true,canSettle:true,onUnauthorized:vi.fn()});
    fireEvent.click((await screen.findAllByLabelText('Matched bank transaction'))[0]!);
    fireEvent.click(await screen.findByText(/Receipt/));
    fireEvent.change(await screen.findByLabelText('Settlement amount a.pdf'),{target:{value:'150'}});
    expect(await screen.findByText('The allocation exceeds the unallocated amount')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Save allocations'})).toBeDisabled();
  });
  it('shows the real document remaining amount and blocks an amount above it',async()=>{
    const tx={id:TX,transaction_date:'2026-01-20',description:'Receipt',bank_reference:'R1',amount:'1000.00',reconciliation_status:'unmatched'};
    const data=candidates('0.00','1000.00');
    Object.assign(data.documents[0]!,{remaining_amount:'25.00'});
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url==='/api/bank-transactions'?new Response(JSON.stringify({transactions:[tx]}),{status:200}):new Response(JSON.stringify(data),{status:200})));
    renderPanel({canView:true,canSettle:true,onUnauthorized:vi.fn()});
    fireEvent.click((await screen.findAllByLabelText('Matched bank transaction'))[0]!);
    fireEvent.click(await screen.findByText(/Receipt/));
    expect(await screen.findByText('25.00')).toBeInTheDocument();
    expect(screen.queryByText('600.00')).not.toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('Settlement amount a.pdf'),{target:{value:'26'}});
    expect(await screen.findByText('An amount exceeds the document remaining amount')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Save allocations'})).toBeDisabled();
  });
});
