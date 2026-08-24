import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Sales} from '../components/Sales';
import {Purchases} from '../components/Purchases';
import {Documents} from '../components/Documents';
import i18n from '../i18n';

const sale=(status='uploaded')=>({id:'sale-doc',original_filename:'sale.pdf',status,document_date:'2026-08-01',reference_number:'SALE-1',total_amount:'100.00',counterparty_id:'customer-1',customer_name:'Customer',receivable_id:null,receivable_original_amount:null,due_on:null,verification_status:null,receivable_cancelled:false,receivable_relationship:'not_created' as const,collected_amount:'0.00',remaining_amount:'100.00',financial_state:'open' as const,settlement_history:[]});
const purchase=(status='uploaded')=>({id:'purchase-doc',document_type:'purchase' as const,original_filename:'purchase.pdf',status,document_date:'2026-08-02',reference_number:'PUR-1',total_amount:'50.00',counterparty_id:'supplier-1',supplier_name:'Supplier',payable_id:null,payable_original_amount:null,due_on:null,verification_status:null,payable_cancelled:false,payable_relationship:'not_created' as const,paid_amount:'0.00',remaining_amount:'50.00',financial_state:'open' as const,settlement_history:[],vat_review_status:'missing' as const,tax_date:null,vat_treatment:null,taxable_amount:null,vat_amount:null});
const document=(id:string,reference:string)=>({id,original_filename:`${id}.pdf`,mime_type:'application/pdf',size_bytes:2048,status:'uploaded',review_note:null,reviewed_at:null,created_at:'2026-08-01T00:00:00Z',document_type:'purchase' as const,counterparty_id:'supplier-1',counterparty_name:'Supplier',relational_counterparty_name:'Supplier',document_date:'2026-08-02',reference_number:reference,total_amount:'50.00',intake_note:null});

describe('Sales and Purchases contextual edit entry points',()=>{
 beforeEach(async()=>{vi.restoreAllMocks();await i18n.changeLanguage('en')});

 it('offers Edit for an uploaded sale only with edit capability and delegates the same document id',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({sales:[sale()]}))));
  const onEditDocument=vi.fn();
  render(<Sales canView canManage={false} canEdit onEditDocument={onEditDocument} onUnauthorized={vi.fn()}/>);
  fireEvent.click((await screen.findByText('SALE-1')).closest('tr')!);
  fireEvent.click(screen.getByRole('button',{name:'Edit'}));
  expect(onEditDocument).toHaveBeenCalledWith('sale-doc');
 });

 it('does not offer Edit for a reviewed sale or without document edit capability',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({sales:[sale('approved')]}))));
  render(<Sales canView canManage={false} canEdit onEditDocument={vi.fn()} onUnauthorized={vi.fn()}/>);
  fireEvent.click((await screen.findByText('SALE-1')).closest('tr')!);
  expect(screen.queryByRole('button',{name:'Edit'})).not.toBeInTheDocument();
 });

 it('offers Edit for an uploaded purchase and delegates the same document id',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({purchases:[purchase()]}))));
  const onEditDocument=vi.fn();
  render(<Purchases canView canManage={false} canEdit onEditDocument={onEditDocument} onUnauthorized={vi.fn()}/>);
  fireEvent.click((await screen.findByText('PUR-1')).closest('tr')!);
  fireEvent.click(screen.getByRole('button',{name:'Edit'}));
  expect(onEditDocument).toHaveBeenCalledWith('purchase-doc');
 });

 it('does not offer Edit for an approved purchase',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({purchases:[purchase('approved')]}))));
  render(<Purchases canView canManage={false} canEdit onEditDocument={vi.fn()} onUnauthorized={vi.fn()}/>);
  fireEvent.click((await screen.findByText('PUR-1')).closest('tr')!);
  expect(screen.queryByRole('button',{name:'Edit'})).not.toBeInTheDocument();
 });

 it('opens the requested existing document in Intake, saves it through the existing PATCH, and returns to Purchases without waiting on a refresh',async()=>{
  const first=document('doc-1','FIRST');
  const target=document('purchase-doc','TARGET');
  const fetchMock=vi.fn()
   .mockResolvedValueOnce(new Response(JSON.stringify({documents:[first,target],counterparties:[{id:'supplier-1',name:'Supplier',type:'supplier',is_active:true}]})))
   .mockResolvedValueOnce(new Response(JSON.stringify({document:target})));
  vi.stubGlobal('fetch',fetchMock);
  const onEntryComplete=vi.fn(),onEntryCancel=vi.fn();
  render(<Documents canView canUpload canReview={false} canApprove={false} entryDocumentId="purchase-doc" entryReturnPage="purchases" entryCounterpartyType="supplier" onEntryComplete={onEntryComplete} onEntryCancel={onEntryCancel} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByDisplayValue('TARGET')).toBeInTheDocument();
  expect(screen.queryByLabelText(/Choose document/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Save Intake'}));
  await waitFor(()=>expect(onEntryComplete).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][0]).toBe('/api/documents/purchase-doc/intake');
  expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({method:'PATCH'}));
 });

 it('preserves the current linked counterparty even when its type does not match the contextual supplier filter',async()=>{
  const target={...document('purchase-doc','TARGET'),counterparty_id:'customer-1',counterparty_name:'Customer',relational_counterparty_name:'Customer'};
  const fetchMock=vi.fn()
   .mockResolvedValueOnce(new Response(JSON.stringify({documents:[target],counterparties:[{id:'customer-1',name:'Customer',type:'customer',is_active:true},{id:'supplier-1',name:'Supplier',type:'supplier',is_active:true}]})))
   .mockResolvedValueOnce(new Response(JSON.stringify({document:target})));
  vi.stubGlobal('fetch',fetchMock);
  const onEntryComplete=vi.fn();
  render(<Documents canView canUpload canReview={false} canApprove={false} entryDocumentId="purchase-doc" entryReturnPage="purchases" entryCounterpartyType="supplier" onEntryComplete={onEntryComplete} onUnauthorized={vi.fn()}/>);
  const counterpartySelect=await screen.findByDisplayValue('Customer');
  expect(counterpartySelect).toHaveValue('customer-1');
  fireEvent.click(screen.getByRole('button',{name:'Save Intake'}));
  await waitFor(()=>expect(onEntryComplete).toHaveBeenCalledOnce());
  const body=JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
  expect(body.counterparty_id).toBe('customer-1');
 });

 it('returns from existing-document edit context without writing when the contextual return action is used',async()=>{
  const target=document('sale-doc','SALE-TARGET');
  const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({documents:[target],counterparties:[]})));
  vi.stubGlobal('fetch',fetchMock);
  const onEntryCancel=vi.fn();
  render(<Documents canView canUpload canReview={false} canApprove={false} entryDocumentId="sale-doc" entryReturnPage="sales" entryCounterpartyType="customer" onEntryCancel={onEntryCancel} onUnauthorized={vi.fn()}/>);
  await screen.findByDisplayValue('SALE-TARGET');
  fireEvent.click(screen.getByRole('button',{name:'Sales'}));
  expect(onEntryCancel).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledOnce();
 });
});
