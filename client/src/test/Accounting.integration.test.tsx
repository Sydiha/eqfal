import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Accounting } from '../components/Accounting';
import { journalLineToEditor, serializeJournalLines } from '../components/accounting-contracts';
import i18n from '../i18n';

const accountId='11111111-1111-4111-8111-111111111111';
const year={id:'33333333-3333-4333-8333-333333333333',name:'2026',start_date:'2026-01-01',end_date:'2026-12-31'};
const account={id:accountId,code:'1000',name:'Cash',account_type:'asset' as const,parent_account_id:null,is_active:true};
const emptyResponses=(url:string)=>url==='/api/accounts'?{accounts:[account]}:url==='/api/fiscal-years'?{fiscalYears:[year]}:url==='/api/journals'?{journals:[]}:{sources:[]};

describe('Accounting integration contracts',()=>{
 beforeEach(async()=>{await i18n.changeLanguage('en');window.history.replaceState(null,'','/?page=accounting')});

 it('serializes loaded lines through the write DTO allowlist',()=>{
  const loaded={id:'line-1',company_id:'company-1',journal_entry_id:'journal-1',account_id:accountId,debit:'10.00',credit:'0.00',memo:null,sequence:1};
  expect(serializeJournalLines([journalLineToEditor(loaded)])).toEqual({lines:[{account_id:accountId,debit:'10.00',credit:'0.00',memo:null}]});
 });

 it('round-trips create, load, save, reload, edit, save, and reload without leaking response fields',async()=>{
  const journal={id:'22222222-2222-4222-8222-222222222222',fiscal_year_id:year.id,accounting_date:'2026-08-01',description:'Round trip',reference:null,entry_type:'standard' as const,status:'draft' as const};
  let created=false;
  let lines=[
   {id:'line-1',company_id:'company-1',journal_entry_id:journal.id,account_id:accountId,debit:'10.00',credit:'0.00',memo:null,sequence:1},
   {id:'line-2',company_id:'company-1',journal_entry_id:journal.id,account_id:accountId,debit:'0.00',credit:'10.00',memo:'Offset',sequence:2},
  ];
  const writes:Record<string,unknown>[]=[];
  const fetchMock=vi.fn(async(url:string,options?:RequestInit)=>{
   const method=options?.method??'GET';
   if(url==='/api/journals'&&method==='POST'){created=true;return new Response(JSON.stringify(journal),{status:201})}
   if(url===`/api/journals/${journal.id}/lines`&&method==='PUT'){
    const body=JSON.parse(String(options?.body)) as {lines:Array<{account_id:string;debit:string;credit:string;memo:string|null}>};
    writes.push(body);
    lines=body.lines.map((line,index)=>({id:`line-${index+1}`,company_id:'company-1',journal_entry_id:journal.id,...line,sequence:index+1}));
    return new Response(JSON.stringify({lines}));
   }
   if(url===`/api/journals/${journal.id}`)return new Response(JSON.stringify({...journal,lines}));
   if(url==='/api/accounts')return new Response(JSON.stringify({accounts:[account]}));
   if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[year]}));
   if(url==='/api/journals')return new Response(JSON.stringify({journals:created?[journal]:[]}));
   return new Response(JSON.stringify({sources:[]}));
  });
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canManageChart={false} canManageJournals canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Journals'}));
  fireEvent.change(screen.getByLabelText('Accounting date'),{target:{value:'2026-08-01'}});
  fireEvent.change(screen.getByLabelText('Description'),{target:{value:'Round trip'}});
  fireEvent.click(screen.getByRole('button',{name:'Create journal'}));
  await screen.findByText('Saved successfully.');
  await waitFor(()=>expect(screen.getByRole('button',{name:/Round trip/})).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button',{name:/Round trip/}));
  let amounts=await screen.findAllByRole('spinbutton');
  fireEvent.change(amounts[0]!,{target:{value:'25.00'}});
  fireEvent.change(amounts[3]!,{target:{value:'25.00'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(writes).toHaveLength(1));
  amounts=screen.getAllByRole('spinbutton');
  expect(amounts[0]).toHaveValue(25);
  expect(amounts[3]).toHaveValue(25);
  fireEvent.change(amounts[0]!,{target:{value:'40.00'}});
  fireEvent.change(amounts[3]!,{target:{value:'40.00'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(writes).toHaveLength(2));
  await waitFor(()=>expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(40));
  for(const write of writes)for(const line of write.lines as Record<string,unknown>[]){
   expect(Object.keys(line).sort()).toEqual(['account_id','credit','debit','memo']);
   expect(line).not.toHaveProperty('id');expect(line).not.toHaveProperty('company_id');expect(line).not.toHaveProperty('journal_entry_id');expect(line).not.toHaveProperty('sequence');
  }
  expect(fetchMock.mock.calls.filter(([url,options])=>url==='/api/journals'&&options?.method==='POST')).toHaveLength(1);
  expect(writes[1]).toEqual({lines:[{account_id:accountId,debit:'40.00',credit:'0.00',memo:null},{account_id:accountId,debit:'0.00',credit:'40.00',memo:'Offset'}]});
  expect(screen.getAllByText('Draft',{selector:'.badge'}).length).toBeGreaterThan(0);
  expect(screen.queryByText('Unable to load or update accounting.')).not.toBeInTheDocument();
 });

 it('keeps a successful creation acknowledged and retries only its failed refresh',async()=>{
  const journal={id:'22222222-2222-4222-8222-222222222222',fiscal_year_id:year.id,accounting_date:'2026-08-01',description:'Created once',reference:null,entry_type:'standard' as const,status:'draft' as const};
  let created=false,failRefresh=true;
  const fetchMock=vi.fn(async(url:string,options?:RequestInit)=>{
   if(url==='/api/journals'&&options?.method==='POST'){created=true;return new Response(JSON.stringify(journal),{status:201})}
   if(created&&failRefresh)return new Response(null,{status:503});
   const value=url==='/api/journals'?{journals:created?[journal]:[]}:emptyResponses(url);
   return new Response(JSON.stringify(value));
  });
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canManageChart={false} canManageJournals canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Journals'}));
  fireEvent.change(screen.getByLabelText('Accounting date'),{target:{value:'2026-08-01'}});
  fireEvent.change(screen.getByLabelText('Description'),{target:{value:'Created once'}});
  fireEvent.click(screen.getByRole('button',{name:'Create journal'}));
  expect(await screen.findByText(/Saved successfully, but the latest data could not be loaded/)).toBeInTheDocument();
  expect(screen.getByText('Saved successfully.')).toBeInTheDocument();
  expect(screen.queryByText('Unable to load or update accounting.')).not.toBeInTheDocument();
  failRefresh=false;
  fireEvent.click(screen.getByRole('button',{name:'Try again'}));
  await waitFor(()=>expect(screen.queryByText(/latest data could not be loaded/)).not.toBeInTheDocument());
  expect(await screen.findByRole('button',{name:/Created once/})).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url,options])=>url==='/api/journals'&&options?.method==='POST')).toHaveLength(1);
 });

 it('does not restore stale success feedback after a later mutation fails and load is retried',async()=>{
  let writes=0;
  const fetchMock=vi.fn(async(url:string,options?:RequestInit)=>{
   if(url==='/api/accounts'&&options?.method==='POST'){
    writes++;
    return writes===1?new Response(JSON.stringify(account),{status:201}):new Response(JSON.stringify({error:'failed'}),{status:500});
   }
   return new Response(JSON.stringify(emptyResponses(url)));
  });
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canManageChart canManageJournals={false} canPost={false} onUnauthorized={vi.fn()}/>);
  let code=await screen.findByRole('textbox',{name:'Code'});
  let name=screen.getByRole('textbox',{name:'Name'});
  fireEvent.change(code,{target:{value:'1000'}});fireEvent.change(name,{target:{value:'Cash'}});
  fireEvent.click(screen.getByRole('button',{name:'Add account'}));
  expect(await screen.findByText('Saved successfully.')).toBeInTheDocument();
  await waitFor(()=>expect(screen.getByRole('button',{name:'Add account'})).toBeEnabled());
  code=screen.getByRole('textbox',{name:'Code'});name=screen.getByRole('textbox',{name:'Name'});
  fireEvent.change(code,{target:{value:'2000'}});fireEvent.change(name,{target:{value:'Receivable'}});
  fireEvent.submit(code.closest('form')!);
  await waitFor(()=>expect(writes).toBe(2));
  expect(await screen.findByText('Unable to load or update accounting.')).toBeInTheDocument();
  expect(screen.queryByText('Saved successfully.')).not.toBeInTheDocument();
  const getsBeforeRetry=fetchMock.mock.calls.filter(([,options])=>(options?.method??'GET')==='GET').length;
  fireEvent.click(screen.getByRole('button',{name:'Try again'}));
  await waitFor(()=>expect(screen.queryByText('Unable to load or update accounting.')).not.toBeInTheDocument());
  expect(screen.queryByText('Saved successfully.')).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([url,options])=>url==='/api/accounts'&&options?.method==='POST')).toHaveLength(2);
  expect(fetchMock.mock.calls.filter(([,options])=>(options?.method??'GET')==='GET')).toHaveLength(getsBeforeRetry+4);
 });
});
