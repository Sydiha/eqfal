import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  if(url.includes('/api/opening-balances/'))return response({year,review,items,summary:{debit:'100.00',credit:difference==='0.00'?'100.00':'0.00',difference,confidence:{high:1,medium:0,low:1}}});
  return response({});
 });
}

describe('OpeningBalanceReview',()=>{
 beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});
 it('shows no-access state without reading APIs',()=>{const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);render(<OpeningBalanceReview canView={false} canManage={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()}/>);expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();expect(fetchMock).not.toHaveBeenCalled();});
 it('formats the opening balance as-of date for display',async()=>{vi.stubGlobal('fetch',loadMock({id:'r1',status:'draft',journal_entry_id:null},[]));render(<OpeningBalanceReview canView canManage canReview canApprove={false} onUnauthorized={vi.fn()}/>);expect(await screen.findByText('01/01/2026')).toBeInTheDocument();expect(screen.queryByText('2026-01-01')).not.toBeInTheDocument();});
 it('shows draft controls and the inventory category to managers',async()=>{vi.stubGlobal('fetch',loadMock({id:'r1',status:'draft',journal_entry_id:null},[]));render(<OpeningBalanceReview canView canManage canReview canApprove={false} onUnauthorized={vi.fn()}/>);expect(await screen.findByRole('button',{name:'Add item'})).toBeInTheDocument();expect(await screen.findByRole('option',{name:'Inventory'})).toBeInTheDocument();});
 it('blocks approval while review is unbalanced',async()=>{const items=[{id:'i1',category:'bank',account_id:cash.id,amount:'100.00',balance_side:'debit',source_type:'bank_statement',source_reference:'statement',confidence:'high',note:null}];vi.stubGlobal('fetch',loadMock({id:'r1',status:'in_review',journal_entry_id:null},items,'100.00'));render(<OpeningBalanceReview canView canManage={false} canReview canApprove onUnauthorized={vi.fn()}/>);const approve=await screen.findByRole('button',{name:'Approve opening balance'});expect(approve).toBeDisabled();expect(screen.getByText(/approval is blocked/i)).toBeInTheDocument();});
 it('requires and sends a return-to-draft reason',async()=>{const items=[{id:'i1',category:'bank',account_id:cash.id,amount:'100.00',balance_side:'debit',source_type:'bank_statement',source_reference:'statement',confidence:'high',note:null}];const fetchMock=loadMock({id:'r1',status:'in_review',journal_entry_id:null},items,'100.00');vi.stubGlobal('fetch',fetchMock);render(<OpeningBalanceReview canView canManage={false} canReview canApprove={false} onUnauthorized={vi.fn()}/>);const button=await screen.findByRole('button',{name:'Return to draft'});expect(button).toBeDisabled();fireEvent.change(screen.getByLabelText('Reason for returning to draft'),{target:{value:'Need supplier reconciliation'}});expect(button).toBeEnabled();fireEvent.click(button);await waitFor(()=>{const call=fetchMock.mock.calls.find(([url,options])=>String(url).endsWith('/return-to-draft')&&(options as RequestInit|undefined)?.method==='POST');expect(call).toBeTruthy();expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({reason:'Need supplier reconciliation'});});});
 it('calls the approve endpoint only when balanced',async()=>{const items=[{id:'i1',category:'bank',account_id:cash.id,amount:'100.00',balance_side:'debit',source_type:'bank_statement',source_reference:'statement',confidence:'high',note:null},{id:'i2',category:'equity',account_id:equity.id,amount:'100.00',balance_side:'credit',source_type:'manual_unverified',source_reference:null,confidence:'low',note:null}];const fetchMock=loadMock({id:'r1',status:'in_review',journal_entry_id:null},items);vi.stubGlobal('fetch',fetchMock);render(<OpeningBalanceReview canView canManage={false} canReview canApprove onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByRole('button',{name:'Approve opening balance'}));await waitFor(()=>expect(fetchMock.mock.calls.some(([url,options])=>String(url).endsWith('/approve')&&(options as RequestInit|undefined)?.method==='POST')).toBe(true));});
});
