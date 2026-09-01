import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Accounting } from '../components/Accounting';
import i18n from '../i18n';

const journal={id:'22222222-2222-4222-8222-222222222222',fiscal_year_id:'33333333-3333-4333-8333-333333333333',accounting_date:'2026-09-10',description:'VAT purchase recognition',reference:null,entry_type:'standard' as const,status:'draft' as const};
const accounts=[
 {id:'11111111-1111-4111-8111-111111111111',code:'1100',name:'Input VAT',account_type:'asset' as const,parent_account_id:null,is_active:true},
 {id:'44444444-4444-4444-8444-444444444444',code:'2100',name:'Payable',account_type:'liability' as const,parent_account_id:null,is_active:true},
];
const lines=[
 {id:'line-1',company_id:'company-1',journal_entry_id:journal.id,account_id:accounts[0]!.id,debit:'150.00',credit:'0.00',memo:null,sequence:1},
 {id:'line-2',company_id:'company-1',journal_entry_id:journal.id,account_id:accounts[1]!.id,debit:'0.00',credit:'150.00',memo:null,sequence:2},
];

describe('Accounting VAT posting feedback',()=>{
 beforeEach(async()=>{await i18n.changeLanguage('en');window.history.replaceState(null,'','/?page=accounting')});

 it('shows the dedicated bilingual VAT integrity message and keeps the draft open',async()=>{
  const fetchMock=vi.fn(async(url:string,options?:RequestInit)=>{
   const method=options?.method??'GET';
   if(url==='/api/accounts')return new Response(JSON.stringify({accounts}));
   if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[{id:journal.fiscal_year_id,name:'2026',start_date:'2026-01-01',end_date:'2026-12-31'}]}));
   if(url==='/api/journals'&&method==='GET')return new Response(JSON.stringify({journals:[journal]}));
   if(url==='/api/accounting/operational-sources')return new Response(JSON.stringify({sources:[]}));
   if(url===`/api/journals/${journal.id}`&&method==='GET')return new Response(JSON.stringify({...journal,lines}));
   if(url===`/api/journals/${journal.id}/post`&&method==='POST')return new Response(JSON.stringify({error:'Reviewed VAT is not correctly recognized in the journal',code:'VAT_RECOGNITION_INCOMPLETE'}),{status:400,headers:{'content-type':'application/json'}});
   throw new Error(`${method} ${url}`);
  });
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canManageChart={false} canManageJournals canPost onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Journals'}));
  fireEvent.click(await screen.findByRole('button',{name:/VAT purchase recognition/}));
  const post=await screen.findByRole('button',{name:'Post journal'});
  expect(post).toBeEnabled();
  fireEvent.click(post);
  expect(await screen.findByText(/لا يمكن ترحيل القيد/)).toHaveTextContent('The journal cannot be posted. The reviewed VAT is not correctly recognized in the journal.');
  expect(screen.getByText('VAT purchase recognition',{selector:'h3'})).toBeInTheDocument();
  expect(screen.getByText('Draft',{selector:'.badge'})).toBeInTheDocument();
  expect(screen.queryByText('Unable to load or update accounting.')).not.toBeInTheDocument();
  await waitFor(()=>expect(fetchMock.mock.calls.filter(([url,options])=>url===`/api/journals/${journal.id}/post`&&options?.method==='POST')).toHaveLength(1));
 });
});
