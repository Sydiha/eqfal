import { fireEvent, screen, waitFor } from './test-utils';
import { render } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpeningBalanceReview } from '../components/OpeningBalanceReview';
import i18n from '../i18n';

const year={id:'11111111-1111-4111-8111-111111111111',name:'FY 2026',start_date:'2026-01-01',end_date:'2026-12-31',status:'open'};
const cash={id:'22222222-2222-4222-8222-222222222222',code:'1000',name:'Cash',account_type:'asset',is_active:true};
const equity={id:'33333333-3333-4333-8333-333333333333',code:'3000',name:'Opening equity',account_type:'equity',is_active:true};
const response=(body:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));

function loadMock(review:unknown,items:unknown[],difference='0.00'){
 return vi.fn().mockImplementation((url:string)=>{
  if(url==='/api/fiscal-years')return response({fiscalYears:[year]});
  if(url==='/api/accounts')return response({accounts:[cash,equity]});
  if(url.endsWith('/suggestions'))return response({suggestions:[]});
  if(url.endsWith('/reconciliation'))return response({status:'verified',blocking:false,issues:[]});
  if(url.endsWith('/exceptions'))return response({required_count:0,accepted_unverified_count:0,stale_count:0,issues:[],exceptions:[]});
  if(url.includes('/api/opening-balances/'))return response({year,review,items,summary:{debit:'100.00',credit:difference==='0.00'?'100.00':'0.00',difference,confidence:{high:1,medium:0,low:1}}});
  return response({});
 });
}


const item={id:'i1',category:'bank',account_id:cash.id,amount:'100.00',balance_side:'debit' as const,source_type:'bank_statement',source_reference:'statement',confidence:'high' as const,note:null};
const draft={id:'r1',status:'draft',journal_entry_id:null};
const mount=(items:unknown[])=>{window.history.replaceState(null,'','/');vi.stubGlobal('fetch',loadMock(draft,items));render(<OpeningBalanceReview canView canCreate canEdit canDelete canSubmit canReview canApprove={false} onUnauthorized={vi.fn()}/>);};
const toggle=(d:HTMLDetailsElement)=>fireEvent(d,new Event('toggle'));

describe('OpeningBalanceReview add-item form state',()=>{
 beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});
 it('is collapsed by default when items exist, even after delayed loading and toggle events',async()=>{
  mount([item]);await screen.findByText('statement');const d=document.getElementById('ob-add-item') as HTMLDetailsElement;
  expect(d.open).toBe(false);toggle(d);toggle(d);expect(d.open).toBe(false);
 });
 it('is open by default when there are no items and stays user-controllable',async()=>{
  mount([]);await screen.findByText('No opening balance items yet.');const d=document.getElementById('ob-add-item') as HTMLDetailsElement;
  expect(d.open).toBe(true);toggle(d);expect(d.open).toBe(true);
  d.open=false;toggle(d);await waitFor(()=>expect(d.open).toBe(false));
 });
 it('lets the user expand and collapse manually when items exist',async()=>{
  mount([item]);await screen.findByText('statement');const d=document.getElementById('ob-add-item') as HTMLDetailsElement;
  d.open=true;toggle(d);await waitFor(()=>expect(d.open).toBe(true));
  d.open=false;toggle(d);await waitFor(()=>expect(d.open).toBe(false));
 });
});
