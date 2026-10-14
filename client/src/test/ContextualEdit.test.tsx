import {fireEvent,screen,waitFor} from './test-utils';
import {render} from './test-utils';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Documents} from '../components/Documents';
import i18n from '../i18n';

const document=(id:string,reference:string,type:'purchase'|'expense'|'sale'='purchase')=>({id,original_filename:`${id}.pdf`,mime_type:'application/pdf',size_bytes:2048,status:'uploaded',review_note:null,reviewed_at:null,created_at:'2026-08-01T00:00:00Z',document_type:type,counterparty_id:type==='sale'?'customer-1':'supplier-1',counterparty_name:type==='sale'?'Customer':'Supplier',relational_counterparty_name:type==='sale'?'Customer':'Supplier',document_date:'2026-08-02',reference_number:reference,total_amount:'50.00',intake_note:null});

describe('Sales and Purchases contextual edit entry points',()=>{
 beforeEach(async()=>{vi.restoreAllMocks();await i18n.changeLanguage('en')});

 it('isolates the requested purchase document, hides upload and navigation, locks its type, saves the same type, and returns',async()=>{
  const first=document('doc-1','FIRST');
  const target=document('purchase-doc','TARGET');
  const fetchMock=vi.fn()
   .mockResolvedValueOnce(new Response(JSON.stringify({documents:[first,target],counterparties:[{id:'supplier-1',name:'Supplier',type:'supplier',is_active:true}]})))
   .mockResolvedValueOnce(new Response(JSON.stringify({document:target})));
  vi.stubGlobal('fetch',fetchMock);
  const onEntryComplete=vi.fn(),onEntryCancel=vi.fn();
  render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} entryDocumentId="purchase-doc" entryReturnPage="purchases" entryCounterpartyType="supplier" onEntryComplete={onEntryComplete} onEntryCancel={onEntryCancel} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByDisplayValue('TARGET')).toBeInTheDocument();
  expect(screen.queryByText('doc-1.pdf')).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Upload Document'})).not.toBeInTheDocument();
  expect(screen.queryByRole('navigation',{name:'Documents'})).not.toBeInTheDocument();
  const typeField=screen.getByLabelText('Document Type');
  expect(typeField).toHaveValue('Purchase');
  expect(typeField).toHaveAttribute('readonly');
  fireEvent.click(screen.getByRole('button',{name:'Save Intake'}));
  await waitFor(()=>expect(onEntryComplete).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][0]).toBe('/api/documents/purchase-doc/intake');
  expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({method:'PATCH'}));
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).document_type).toBe('purchase');
 });

 it('locks a contextual sales edit to the original sale type',async()=>{
  const target=document('sale-doc','SALE-TARGET','sale');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({documents:[target],counterparties:[{id:'customer-1',name:'Customer',type:'customer',is_active:true}]}))));
  render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} entryDocumentId="sale-doc" entryReturnPage="sales" entryCounterpartyType="customer" onEntryCancel={vi.fn()} onUnauthorized={vi.fn()}/>);
  await screen.findByDisplayValue('SALE-TARGET');
  const typeField=screen.getByLabelText('Document Type');
  expect(typeField).toHaveValue('Sale');
  expect(typeField).toHaveAttribute('readonly');
 });

 it('does not fall back to another document when the requested contextual document is missing',async()=>{
  const first=document('doc-1','FIRST');
  const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({documents:[first],counterparties:[]})));
  vi.stubGlobal('fetch',fetchMock);
  const onEntryCancel=vi.fn();
  render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} entryDocumentId="missing-doc" entryReturnPage="purchases" entryCounterpartyType="supplier" onEntryCancel={onEntryCancel} onUnauthorized={vi.fn()}/>);
  await waitFor(()=>expect(screen.queryByText('Loading documents...')).not.toBeInTheDocument());
  expect(screen.queryByText('doc-1.pdf')).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue('FIRST')).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Upload Document'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Purchases'}));
  expect(onEntryCancel).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledOnce();
 });

 it('preserves the current linked counterparty even when its type does not match the contextual supplier filter',async()=>{
  const target={...document('purchase-doc','TARGET'),counterparty_id:'customer-1',counterparty_name:'Customer',relational_counterparty_name:'Customer'};
  const fetchMock=vi.fn()
   .mockResolvedValueOnce(new Response(JSON.stringify({documents:[target],counterparties:[{id:'customer-1',name:'Customer',type:'customer',is_active:true},{id:'supplier-1',name:'Supplier',type:'supplier',is_active:true}]})))
   .mockResolvedValueOnce(new Response(JSON.stringify({document:target})));
  vi.stubGlobal('fetch',fetchMock);
  const onEntryComplete=vi.fn();
  render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} entryDocumentId="purchase-doc" entryReturnPage="purchases" entryCounterpartyType="supplier" onEntryComplete={onEntryComplete} onUnauthorized={vi.fn()}/>);
  const counterpartySelect=await screen.findByDisplayValue('Customer');
  expect(counterpartySelect).toHaveValue('customer-1');
  fireEvent.click(screen.getByRole('button',{name:'Save Intake'}));
  await waitFor(()=>expect(onEntryComplete).toHaveBeenCalledOnce());
  const body=JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
  expect(body.counterparty_id).toBe('customer-1');
  expect(body.document_type).toBe('purchase');
 });

 it('returns from existing-document edit context without writing when the contextual return action is used',async()=>{
  const target=document('sale-doc','SALE-TARGET','sale');
  const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({documents:[target],counterparties:[]})));
  vi.stubGlobal('fetch',fetchMock);
  const onEntryCancel=vi.fn();
  render(<Documents canEdit canSubmit canView canUpload canReview={false} canApprove={false} entryDocumentId="sale-doc" entryReturnPage="sales" entryCounterpartyType="customer" onEntryCancel={onEntryCancel} onUnauthorized={vi.fn()}/>);
  await screen.findByDisplayValue('SALE-TARGET');
  fireEvent.click(screen.getByRole('button',{name:'Sales'}));
  expect(onEntryCancel).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledOnce();
 });
});
