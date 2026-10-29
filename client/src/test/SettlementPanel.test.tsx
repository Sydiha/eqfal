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

  describe('refresh after a document settlement',()=>{
    const DOC='55555555-5555-4555-8555-555555555555';
    const money=(cents:number)=>(cents/100).toFixed(2);
    // Minimal stateful server: one 100.00 bank transaction matched to one 100.00 document.
    function makeServer(seed:{settled?:number}={}){
      const st={settled:seed.settled??0,failList:false,omitUnallocated:false,log:[] as string[],settlements:[] as Array<{id:string;amount:string}>};
      if(st.settled)st.settlements.push({id:'s0',amount:money(st.settled)});
      const json=(b:unknown,status=200)=>new Response(JSON.stringify(b),{status});
      const fetchMock=vi.fn(async(url:string,init?:RequestInit)=>{
        const method=init?.method??'GET'; st.log.push(`${method} ${url}`);
        if(url==='/api/bank-transactions')return st.failList?json({error:'boom'},500):json({transactions:[{id:TX,transaction_date:'2026-01-20',description:'Receipt',bank_reference:'R1',amount:'100.00',reconciliation_status:st.settled>=10000?'reconciled':'matched'}]});
        if(url.endsWith('/match-candidates'))return json({transaction:{id:TX,amount:'100.00',reconciliation_status:'matched'},match:{document_id:DOC},matches:[{document_id:DOC}],allocated_amount:money(st.settled),...(st.omitUnallocated?{}:{unallocated_amount:money(10000-st.settled)}),documents:[]});
        if(url===`/api/documents/${DOC}/settlements`&&method==='GET')return json({document:{id:DOC,status:'approved',original_filename:'inv.pdf',total_amount:'100.00'},settled_amount:money(st.settled),remaining_amount:money(10000-st.settled),payment_status:st.settled===0?'unpaid':st.settled>=10000?'paid':'partially_paid',settlements:st.settlements.map(x=>({id:x.id,bank_transaction_id:TX,amount:x.amount,created_at:'2026-01-20',note:null,transaction_date:'2026-01-20',transaction_description:'Receipt',bank_reference:'R1',transaction_amount:'100.00'}))});
        if(url===`/api/documents/${DOC}/settlements`&&method==='POST'){const cents=Math.round(Number(JSON.parse(String(init!.body)).amount)*100);st.settled+=cents;st.settlements.push({id:`s${st.settlements.length+1}`,amount:money(cents)});return json({},201);}
        if(method==='DELETE'){const id=url.split('/').pop()!;const gone=st.settlements.find(x=>x.id===id)!;st.settled-=Math.round(Number(gone.amount)*100);st.settlements=st.settlements.filter(x=>x.id!==id);return json({});}
        return json({},404);
      });
      vi.stubGlobal('fetch',fetchMock);
      return {st,fetchMock};
    }
    const select=async()=>{fireEvent.click((await screen.findAllByLabelText('Matched bank transaction'))[0]!);fireEvent.click(await screen.findByText(/Receipt/));await screen.findByText('Selected payment');};
    const metric=(label:string)=>screen.getByText(label,{selector:'span'}).parentElement!.querySelector('strong')!.textContent;
    const txInput=()=>screen.getAllByLabelText('Matched bank transaction').find(e=>e.tagName==='INPUT') as HTMLInputElement;
    const amountInput=()=>screen.getByLabelText(/Settlement amount/) as HTMLInputElement;
    const posts=(log:string[])=>log.filter(l=>l.startsWith('POST ')).length;

    it('partial settlement refreshes totals, status, default amount, and the transaction list',async()=>{
      const {st}=makeServer();
      renderPanel({canView:true,canSettle:true,onUnauthorized:vi.fn()});
      await select();
      expect(amountInput().value).toBe('100');
      fireEvent.change(amountInput(),{target:{value:'40'}});
      fireEvent.click(screen.getByRole('button',{name:'Record settlement'}));
      await waitFor(()=>expect(metric('Settled')).toBe('40.00'));
      expect(metric('Remaining')).toBe('60.00');
      expect(metric('Payment status')).toBe('Partially paid');
      expect(amountInput().value).toBe('60');
      expect(st.log.filter(l=>l==='GET /api/bank-transactions').length).toBe(2);
      expect(st.log.filter(l=>l.endsWith('/match-candidates')).length).toBe(2);
      expect(posts(st.log)).toBe(1);
    });

    it('full settlement shows Paid and no longer offers the settlement form',async()=>{
      makeServer();
      renderPanel({canView:true,canSettle:true,onUnauthorized:vi.fn()});
      await select();
      fireEvent.click(screen.getByRole('button',{name:'Record settlement'}));
      await waitFor(()=>expect(metric('Payment status')).toBe('Paid'));
      expect(metric('Remaining')).toBe('0.00');
      expect(screen.queryByRole('button',{name:'Record settlement'})).not.toBeInTheDocument();
    });

    it('removal restores remaining amount and recomputes the default amount',async()=>{
      const {st}=makeServer({settled:4000});
      renderPanel({canView:true,canSettle:true,onUnauthorized:vi.fn()});
      await select();
      expect(amountInput().value).toBe('60');
      fireEvent.change(screen.getByLabelText('Deletion reason'),{target:{value:'mistake'}});
      fireEvent.click(screen.getByRole('button',{name:'Delete settlement'}));
      await waitFor(()=>expect(metric('Payment status')).toBe('Unpaid'));
      expect(metric('Remaining')).toBe('100.00');
      expect(amountInput().value).toBe('100');
      expect(st.log.filter(l=>l.startsWith('DELETE ')).length).toBe(1);
    });

    it('a failed refresh after a successful save hides stale values and retry never repeats the mutation',async()=>{
      const {st}=makeServer();
      renderPanel({canView:true,canSettle:true,onUnauthorized:vi.fn()});
      await select();
      fireEvent.change(amountInput(),{target:{value:'40'}});
      st.failList=true;
      fireEvent.click(screen.getByRole('button',{name:'Record settlement'}));
      expect(await screen.findByText(/The change was saved, but the screen could not be refreshed/)).toBeInTheDocument();
      expect(screen.queryByText('Selected payment')).not.toBeInTheDocument();
      expect(screen.queryByText('Remaining')).not.toBeInTheDocument();
      expect(posts(st.log)).toBe(1);
      st.failList=false;
      fireEvent.click(screen.getByRole('button',{name:'Retry'}));
      await waitFor(()=>expect(metric('Settled')).toBe('40.00'));
      expect(posts(st.log)).toBe(1);
      expect(screen.queryByText(/could not be refreshed/)).not.toBeInTheDocument();
    });

    it('leaves the default amount empty when the server does not confirm the unallocated amount',async()=>{
      const {st}=makeServer();
      st.omitUnallocated=true;
      renderPanel({canView:true,canSettle:true,onUnauthorized:vi.fn()});
      await select();
      expect(amountInput().value).toBe('');
      expect(metric('Remaining')).toBe('100.00');
    });

    it('locks the transaction list after a failed refresh, keeps the selection for retry, and unlocks after a successful reload',async()=>{
      const {st}=makeServer();
      renderPanel({canView:true,canSettle:true,onUnauthorized:vi.fn()});
      await select();
      fireEvent.change(amountInput(),{target:{value:'40'}});
      st.failList=true;
      fireEvent.click(screen.getByRole('button',{name:'Record settlement'}));
      await screen.findByText(/could not be refreshed/);
      const field=txInput();
      expect(field).toBeDisabled();
      expect(field.value).toMatch(/Receipt/);
      st.failList=false;
      fireEvent.click(screen.getByRole('button',{name:'Retry'}));
      await waitFor(()=>expect(metric('Settled')).toBe('40.00'));
      const after=txInput();
      expect(after).not.toBeDisabled();
      expect(after.value).toMatch(/Receipt/);
      expect(posts(st.log)).toBe(1);
    });

    it('drops a stale response that arrives after a newer load',async()=>{
      const txB={id:'66666666-6666-4666-8666-666666666666',transaction_date:'2026-02-01',description:'Newer',bank_reference:'R2',amount:'5.00',reconciliation_status:'matched'};
      const txA={...txB,id:TX,description:'Older',bank_reference:'R1'};
      let releaseA:(r:Response)=>void=()=>{};
      const first=new Promise<Response>(r=>{releaseA=r;});
      const fetchMock=vi.fn().mockReturnValueOnce(first).mockResolvedValue(new Response(JSON.stringify({transactions:[txB]}),{status:200}));
      vi.stubGlobal('fetch',fetchMock);
      const view=renderPanel({canView:true,canSettle:true,onUnauthorized:vi.fn()});
      view.rerender(<MantineProvider><SettlementPanel canView={false} canSettle={true} onUnauthorized={vi.fn()}/></MantineProvider>);
      view.rerender(<MantineProvider><SettlementPanel canView={true} canSettle={true} onUnauthorized={vi.fn()}/></MantineProvider>);
      await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(2));
      releaseA(new Response(JSON.stringify({transactions:[txA]}),{status:200}));
      await new Promise(r=>setTimeout(r,20));
      fireEvent.click((await screen.findAllByLabelText('Matched bank transaction'))[0]!);
      expect(await screen.findByText(/Newer/)).toBeInTheDocument();
      expect(screen.queryByText(/Older/)).not.toBeInTheDocument();
    });

    it('multi-document allocation refreshes candidates and hides fully settled documents',async()=>{
      const tx={id:TX,transaction_date:'2026-01-20',description:'Receipt',bank_reference:'R1',amount:'1000.00',reconciliation_status:'unmatched'};
      let allocated=false;
      const fetchMock=vi.fn(async(url:string,init?:RequestInit)=>{
        if(url==='/api/bank-transactions')return new Response(JSON.stringify({transactions:[tx]}),{status:200});
        if(url.endsWith('/allocations')&&init?.method==='POST'){allocated=true;return new Response('{}',{status:201});}
        const data=candidates(allocated?'600.00':'0.00',allocated?'400.00':'1000.00');
        Object.assign(data.documents[0]!,{remaining_amount:allocated?'0.00':'600.00'});
        Object.assign(data.documents[1]!,{remaining_amount:'400.00'});
        return new Response(JSON.stringify(data),{status:200});
      });
      vi.stubGlobal('fetch',fetchMock);
      renderPanel({canView:true,canSettle:true,onUnauthorized:vi.fn()});
      fireEvent.click((await screen.findAllByLabelText('Matched bank transaction'))[0]!);
      fireEvent.click(await screen.findByText(/Receipt/));
      fireEvent.change(await screen.findByLabelText('Settlement amount a.pdf'),{target:{value:'600'}});
      fireEvent.click(screen.getByRole('button',{name:'Save allocations'}));
      await waitFor(()=>expect(screen.queryByLabelText('Settlement amount a.pdf')).not.toBeInTheDocument());
      expect(screen.getByLabelText('Settlement amount b.pdf')).toBeInTheDocument();
      expect(screen.getByText('400.00',{selector:'strong'})).toBeInTheDocument();
    });
  });
});
