import {act,fireEvent,render,screen,waitFor,within} from './test-utils';
import {cleanup} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {InvoiceWorkspace} from '../components/SalesInvoices';
import {Dialog} from '../components/Dialog';
import {Purchases} from '../components/Purchases';
import {nextAction,sumDecimalStrings} from '../components/invoiceWorkspaceLogic';
import i18n from '../i18n';

const ID='11111111-1111-4111-8111-111111111111',PARTY='22222222-2222-4222-8222-222222222222',OBLIGATION='33333333-3333-4333-8333-333333333333',JOURNAL='44444444-4444-4444-8444-444444444444',DOC='55555555-5555-4555-8555-555555555555';
const base={id:ID,status:'draft',counterparty_id:PARTY,counterparty_name:'Gulf Supplies',internal_number:null,external_reference:'REF-9',issue_date:'2026-10-01',due_date:'2026-10-31',supply_date:null,tax_point_date:'2026-10-01',currency:'SAR',subtotal_amount:'100.00',vat_amount:'15.00',total_amount:'115.00',notes:null,version:2,created_by_user_id:'creator',source_document_id:null,
 lines:[{line_number:1,description:'Item',quantity:'1',unit_price:'100.00',discount_amount:'0.00',vat_rate:'15.00',net_amount:'100.00',vat_amount:'15.00',total_amount:'115.00',vat_treatment:'standard',vat_recoverability:'fully_recoverable'}],
 obligation:null,journal:null,vat:{status:'pending',review_id:null,tax_date:null},paid_amount:null,outstanding_amount:null,actionable_status:'draft'};
const approved={...base,status:'approved',internal_number:'PINV-0001',obligation:{id:OBLIGATION,is_cancelled:false,original_amount:'115.00'},journal:{id:JOURNAL,status:'draft'},vat:{status:'reviewed',review_id:'r',tax_date:'2026-10-01'},paid_amount:'15.00',outstanding_amount:'100.00',actionable_status:'awaiting_posting'};
const caps={canView:true,canCreate:true,canEdit:true,canSubmit:true};
const full={...caps,canApprove:true,canConfirmObligation:true,canCreateJournal:true,canPostJournal:true,canViewAccounting:true,canViewObligations:true,canViewVat:true,canViewDocuments:true,currentUserId:'approver'};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});

type Handler=(url:string,init?:RequestInit)=>Response|undefined;
function mockApi(invoice:Record<string,unknown>=base,extra:Handler=()=>undefined,listBody?:Record<string,unknown>){
 const fetchMock=vi.fn((url:string,init?:RequestInit)=>{
  const method=init?.method??'GET';
  const custom=extra(`${method} ${url}`,init);
  if(custom)return Promise.resolve(custom);
  const path=url.split('?')[0];
  if(method==='GET'&&path==='/api/invoices')return Promise.resolve(json(listBody??{invoices:[invoice],total:1,limit:25,offset:0}));
  if(method==='GET'&&path===`/api/invoices/${ID}`)return Promise.resolve(json({invoice}));
  if(path==='/api/invoices/customers')return Promise.resolve(json(url.includes('direction=purchase')?{suppliers:[{id:PARTY,name:'Gulf Supplies',type:'supplier'}]}:{customers:[{id:PARTY,name:'Gulf Supplies',type:'customer'}]}));
  if(path==='/api/documents')return Promise.resolve(json({documents:[{id:DOC,original_filename:'bill.pdf',reference_number:'BILL-1',document_type:'purchase',status:'approved',document_date:'2026-09-30'},{id:'sale-doc',original_filename:'sale.pdf',reference_number:'SALE-1',document_type:'sale',status:'approved',document_date:null},{id:'rejected-doc',original_filename:'bad.pdf',reference_number:'BAD-1',document_type:'purchase',status:'rejected',document_date:null}]}));
  return Promise.resolve(json({},404));
 });
 vi.stubGlobal('fetch',fetchMock);
 return fetchMock;
}
const calls=(fetchMock:ReturnType<typeof vi.fn>,needle:string)=>fetchMock.mock.calls.filter(c=>`${(c[1] as RequestInit|undefined)?.method??'GET'} ${String(c[0])}`.includes(needle));
const listCalls=(fetchMock:ReturnType<typeof vi.fn>)=>fetchMock.mock.calls.map(c=>String(c[0])).filter(u=>u.startsWith('/api/invoices?'));
const lastList=(fetchMock:ReturnType<typeof vi.fn>)=>new URL(listCalls(fetchMock).at(-1)!,'http://x').searchParams;

beforeEach(async()=>{vi.restoreAllMocks();window.history.replaceState(null,'','/?page=purchases');document.body.style.overflow='';await i18n.changeLanguage('en')});

describe('Purchase direction',()=>{
 it('lists purchase invoices with the supplier picker and supplier wording',async()=>{
  const fetchMock=mockApi();
  render(<InvoiceWorkspace {...caps} direction="purchase" onUnauthorized={vi.fn()}/>);
  expect(await screen.findByRole('heading',{name:'Purchase invoices'})).toBeInTheDocument();
  await screen.findByText('REF-9');
  expect(lastList(fetchMock).get('direction')).toBe('purchase');
  expect(calls(fetchMock,'/api/invoices/customers?direction=purchase').length).toBeGreaterThan(0);
  expect(screen.getByRole('columnheader',{name:'Supplier'})).toBeInTheDocument();
  expect(within(screen.getByRole('search')).getByRole('option',{name:'All suppliers'})).toBeInTheDocument();
 });

 it('creates a purchase draft with direction purchase, an explicit recoverability and no sales rate lookup',async()=>{
  const fetchMock=mockApi(base,(key)=>key==='POST /api/invoices'?json({invoice:base},201):undefined);
  render(<InvoiceWorkspace {...caps} direction="purchase" onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Add purchase invoice +'}));
  const dialog=await screen.findByRole('dialog');
  await waitFor(()=>expect(within(dialog).getByRole('option',{name:'Gulf Supplies'})).toBeInTheDocument());
  fireEvent.change(within(dialog).getByLabelText('Supplier'),{target:{value:PARTY}});
  fireEvent.change(within(dialog).getByLabelText('Issue date'),{target:{value:'2026-10-01'}});
  fireEvent.change(within(dialog).getByLabelText('Tax point date'),{target:{value:'2026-10-01'}});
  fireEvent.change(within(dialog).getByLabelText('Description'),{target:{value:'Stationery'}});
  fireEvent.change(within(dialog).getByLabelText('Unit price'),{target:{value:'100.00'}});
  fireEvent.change(within(dialog).getByLabelText('VAT treatment'),{target:{value:'standard'}});
  fireEvent.change(within(dialog).getByLabelText('VAT rate %'),{target:{value:'15.00'}});
  fireEvent.change(within(dialog).getByLabelText(/^Input VAT recovery/),{target:{value:'fully_recoverable'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'Save draft'}));
  await waitFor(()=>expect(calls(fetchMock,'POST /api/invoices').length).toBe(1));
  const body=JSON.parse((calls(fetchMock,'POST /api/invoices')[0]![1] as RequestInit).body as string);
  expect(body.direction).toBe('purchase');
  expect(body.lines[0]).toEqual({description:'Stationery',quantity:'1',unit_price:'100.00',vat_rate:'15.00',vat_treatment:'standard',vat_recoverability:'fully_recoverable'});
  expect(calls(fetchMock,'/api/invoices/standard-rate')).toEqual([]);
 });

 it('offers only non-rejected purchase or expense documents as evidence, and only with document.view',async()=>{
  mockApi();
  const {unmount}=render(<InvoiceWorkspace {...caps} canViewDocuments direction="purchase" onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Add purchase invoice +'}));
  const dialog=await screen.findByRole('dialog');
  await waitFor(()=>expect(within(dialog).getByRole('option',{name:'BILL-1 · 2026-09-30'})).toBeInTheDocument());
  expect(within(dialog).queryByRole('option',{name:'SALE-1'})).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('option',{name:'BAD-1'})).not.toBeInTheDocument();
  unmount();
  const fetchMock=mockApi();
  render(<InvoiceWorkspace {...caps} direction="purchase" onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Add purchase invoice +'}));
  await screen.findByRole('dialog');
  expect(screen.queryByLabelText('Evidence document (optional)')).not.toBeInTheDocument();
  expect(calls(fetchMock,'/api/documents')).toEqual([]);
 });

 it('sends the existing evidence link back on edit so a full replacement never silently unlinks it',async()=>{
  const linked={...base,source_document_id:DOC};
  const fetchMock=mockApi(linked,(key)=>key===`PUT /api/invoices/${ID}`?json({invoice:linked}):undefined);
  render(<InvoiceWorkspace {...caps} direction="purchase" onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-9'));
  fireEvent.click(await screen.findByRole('button',{name:'Edit'}));
  const dialog=await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button',{name:'Save draft'}));
  await waitFor(()=>expect(calls(fetchMock,'PUT ').length).toBe(1));
  const body=JSON.parse((calls(fetchMock,'PUT ')[0]![1] as RequestInit).body as string);
  expect(body.source_document_id).toBe(DOC);
  expect(body.lines[0].vat_recoverability).toBe('fully_recoverable');
 });
});

describe('Purchase VAT recovery treatments',()=>{
 async function fill(dialog:HTMLElement){
  await waitFor(()=>expect(within(dialog).getByRole('option',{name:'Gulf Supplies'})).toBeInTheDocument());
  fireEvent.change(within(dialog).getByLabelText('Supplier'),{target:{value:PARTY}});
  fireEvent.change(within(dialog).getByLabelText('Issue date'),{target:{value:'2026-10-01'}});
  fireEvent.change(within(dialog).getByLabelText('Tax point date'),{target:{value:'2026-10-01'}});
  fireEvent.change(within(dialog).getByLabelText('Description'),{target:{value:'Item'}});
  fireEvent.change(within(dialog).getByLabelText('Unit price'),{target:{value:'100.00'}});
  fireEvent.change(within(dialog).getByLabelText('VAT treatment'),{target:{value:'standard'}});
  fireEvent.change(within(dialog).getByLabelText('VAT rate %'),{target:{value:'15.00'}});
 }
 const post=async(choose:(dialog:HTMLElement)=>void)=>{
  const fetchMock=mockApi(base,(key)=>key==='POST /api/invoices'?json({invoice:base},201):undefined);
  render(<InvoiceWorkspace {...caps} direction="purchase" onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Add purchase invoice +'}));
  const dialog=await screen.findByRole('dialog');
  await fill(dialog);choose(dialog);
  fireEvent.click(within(dialog).getByRole('button',{name:'Save draft'}));
  await waitFor(()=>expect(calls(fetchMock,'POST /api/invoices').length).toBe(1));
  return JSON.parse((calls(fetchMock,'POST /api/invoices')[0]![1] as RequestInit).body as string).lines[0];
 };
 const pick=(dialog:HTMLElement,value:string)=>fireEvent.change(within(dialog).getByLabelText(/^Input VAT recovery/),{target:{value}});
 it('offers all three supported treatments',async()=>{
  mockApi();
  render(<InvoiceWorkspace {...caps} direction="purchase" onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Add purchase invoice +'}));
  const dialog=await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('VAT treatment'),{target:{value:'standard'}});
  const options=within(within(dialog).getByLabelText(/^Input VAT recovery/)).getAllByRole('option').map(o=>(o as HTMLOptionElement).value);
  expect(options).toEqual(['','fully_recoverable','partially_recoverable','non_recoverable']);
 });
 it('sends non_recoverable without a percent',async()=>{
  const line=await post(d=>pick(d,'non_recoverable'));
  expect(line.vat_recoverability).toBe('non_recoverable');expect(line.vat_recoverable_percent).toBeUndefined();
 });
 it('requires and sends the explicit percent for partially_recoverable, and drops it when the choice changes',async()=>{
  const line=await post(d=>{pick(d,'partially_recoverable');fireEvent.change(within(d).getByLabelText(/^Recoverable share/),{target:{value:'60'}})});
  expect(line.vat_recoverability).toBe('partially_recoverable');expect(line.vat_recoverable_percent).toBe('60');
 });
 it('does not send a stale percent after switching away from partial',async()=>{
  const line=await post(d=>{pick(d,'partially_recoverable');fireEvent.change(within(d).getByLabelText(/^Recoverable share/),{target:{value:'60'}});pick(d,'fully_recoverable')});
  expect(line.vat_recoverability).toBe('fully_recoverable');expect(line.vat_recoverable_percent).toBeUndefined();
 });
 it('keeps a saved partial treatment and percent when editing',async()=>{
  const saved={...base,lines:[{...base.lines[0]!,vat_recoverability:'partially_recoverable',vat_recoverable_percent:'40.00'}]};
  const fetchMock=mockApi(saved,(key)=>key===`PUT /api/invoices/${ID}`?json({invoice:saved}):undefined);
  render(<InvoiceWorkspace {...caps} direction="purchase" onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-9'));
  fireEvent.click(await screen.findByRole('button',{name:'Edit'}));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button',{name:'Save draft'}));
  await waitFor(()=>expect(calls(fetchMock,'PUT ').length).toBe(1));
  const line=JSON.parse((calls(fetchMock,'PUT ')[0]![1] as RequestInit).body as string).lines[0];
  expect([line.vat_recoverability,line.vat_recoverable_percent]).toEqual(['partially_recoverable','40.00']);
 });
});

describe('Functional filters',()=>{
 it('combines status, counterparty and date range, mirrors them in the URL and resets everything',async()=>{
  const fetchMock=mockApi();
  render(<InvoiceWorkspace {...caps} direction="purchase" onUnauthorized={vi.fn()}/>);
  await screen.findByText('REF-9');
  const bar=within(screen.getByRole('search'));
  await waitFor(()=>expect(bar.getByRole('option',{name:'Gulf Supplies'})).toBeInTheDocument());
  fireEvent.change(bar.getByLabelText('Supplier'),{target:{value:PARTY}});
  fireEvent.change(bar.getByLabelText('Status'),{target:{value:'approved'}});
  fireEvent.change(bar.getByLabelText('Issued from'),{target:{value:'2026-10-01'}});
  fireEvent.change(bar.getByLabelText('Issued to'),{target:{value:'2026-10-31'}});
  await waitFor(()=>{const q=lastList(fetchMock);expect([q.get('counterparty_id'),q.get('status'),q.get('from'),q.get('to')]).toEqual([PARTY,'approved','2026-10-01','2026-10-31'])});
  expect(lastList(fetchMock).get('direction')).toBe('purchase');
  const url=new URL(window.location.href);
  expect([url.searchParams.get('purchaseInvStatus'),url.searchParams.get('purchaseInvParty'),url.searchParams.get('purchaseInvFrom'),url.searchParams.get('purchaseInvTo'),url.searchParams.get('page')]).toEqual(['approved',PARTY,'2026-10-01','2026-10-31','purchases']);
  fireEvent.click(bar.getByRole('button',{name:'Reset filters'}));
  await waitFor(()=>{const q=lastList(fetchMock);expect([q.get('counterparty_id'),q.get('status'),q.get('from'),q.get('to'),q.get('q')]).toEqual([null,null,null,null,null])});
  expect(new URL(window.location.href).searchParams.get('purchaseInvStatus')).toBeNull();
  expect(new URL(window.location.href).searchParams.get('page')).toBe('purchases');
 });

 it('restores the supported filters from the URL, which is how they survive contextual navigation',async()=>{
  window.history.replaceState(null,'',`/?page=sales&salesInvStatus=submitted&salesInvParty=${PARTY}&salesInvQ=acme&salesInvFrom=2026-01-01&salesInvStatus2=bogus`);
  const fetchMock=mockApi();
  render(<InvoiceWorkspace {...caps} onUnauthorized={vi.fn()}/>);
  await screen.findByText('REF-9');
  const q=lastList(fetchMock);
  expect([q.get('direction'),q.get('status'),q.get('counterparty_id'),q.get('q'),q.get('from')]).toEqual(['sales','submitted',PARTY,'acme','2026-01-01']);
  expect(screen.getByLabelText('Search')).toHaveValue('acme');
 });

 it('ignores invalid values in the URL',async()=>{
  window.history.replaceState(null,'','/?page=sales&salesInvStatus=hacked&salesInvParty=not-a-uuid&salesInvFrom=2026-02-31');
  const fetchMock=mockApi();
  render(<InvoiceWorkspace {...caps} onUnauthorized={vi.fn()}/>);
  await screen.findByText('REF-9');
  const q=lastList(fetchMock);
  expect([q.get('status'),q.get('counterparty_id'),q.get('from')]).toEqual([null,null,null]);
 });

 it('debounces the reference and amount search into the q filter',async()=>{
  const fetchMock=mockApi();
  render(<InvoiceWorkspace {...caps} onUnauthorized={vi.fn()}/>);
  await screen.findByText('REF-9');
  const before=listCalls(fetchMock).length;
  fireEvent.change(screen.getByLabelText('Search'),{target:{value:' 115.00 '}});
  expect(listCalls(fetchMock).length).toBe(before);
  await waitFor(()=>expect(lastList(fetchMock).get('q')).toBe('115.00'));
  expect(new URL(window.location.href).searchParams.get('salesInvQ')).toBe(' 115.00 ');
 });

 it('does not query with an inverted date range and says why',async()=>{
  const fetchMock=mockApi();
  render(<InvoiceWorkspace {...caps} onUnauthorized={vi.fn()}/>);
  await screen.findByText('REF-9');
  const before=listCalls(fetchMock).length;
  fireEvent.change(screen.getByLabelText('Issued from'),{target:{value:'2026-10-31'}});
  fireEvent.change(screen.getByLabelText('Issued to'),{target:{value:'2026-10-01'}});
  expect(await screen.findByText('The end date is before the start date.')).toBeInTheDocument();
  // the first change (a valid from-only range) may fetch once; the inverted range must not
  expect(listCalls(fetchMock).length).toBeLessThanOrEqual(before+1);
 });

 it('shows a filtered empty state with reset, distinct from the no-invoices empty state',async()=>{
  const fetchMock=mockApi(base,()=>undefined,{invoices:[],total:0,limit:25,offset:0});
  window.history.replaceState(null,'','/?page=sales&salesInvStatus=cancelled');
  render(<InvoiceWorkspace {...caps} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByText('No invoices match these filters.')).toBeInTheDocument();
  expect(screen.queryByText('No sales invoices yet.')).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByText('No invoices match these filters.').parentElement!).getByRole('button',{name:'Reset filters'}));
  expect(await screen.findByText('No sales invoices yet.')).toBeInTheDocument();
  expect(lastList(fetchMock).get('status')).toBeNull();
 });

 it('paginates with the server offset and shows the server total and an exact page subtotal',async()=>{
  const rows=Array.from({length:25},(_,i)=>({...base,id:`${ID.slice(0,-2)}${String(i).padStart(2,'0')}`,external_reference:`R-${i}`,total_amount:'0.10'}));
  const fetchMock=mockApi(base,()=>undefined,{invoices:rows,total:60,limit:25,offset:0});
  render(<InvoiceWorkspace {...caps} onUnauthorized={vi.fn()}/>);
  await screen.findByText('R-0');
  expect(screen.getByText('60 invoices, total of this page: 2.50')).toBeInTheDocument();
  expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Previous'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Next'}));
  await waitFor(()=>expect(lastList(fetchMock).get('offset')).toBe('25'));
  expect(new URL(window.location.href).searchParams.get('salesInvPage')).toBe('2');
  fireEvent.change(screen.getByLabelText('Status'),{target:{value:'draft'}});
  await waitFor(()=>expect(lastList(fetchMock).get('offset')).toBe('0'));
 });
});

describe('Approval, accounting and next action',()=>{
 const submitted={...base,status:'submitted',actionable_status:'awaiting_approval'};
 it('lets a different user with the full capability set approve, and refreshes from the server',async()=>{
  const fetchMock=mockApi(submitted,(key)=>key===`POST /api/invoices/${ID}/approve`?json({invoice:approved,obligation_id:OBLIGATION,journal_id:JOURNAL,vat_review_id:'r'}):undefined);
  render(<InvoiceWorkspace {...full} direction="purchase" onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-9'));
  fireEvent.click(await screen.findByRole('button',{name:'Approve invoice'}));
  await waitFor(()=>expect(calls(fetchMock,`POST /api/invoices/${ID}/approve`).length).toBe(1));
  expect(JSON.parse((calls(fetchMock,'/approve')[0]![1] as RequestInit).body as string)).toEqual({version:2});
  // approving never posts or settles anything
  expect(calls(fetchMock,'/api/accounting')).toEqual([]);
  expect(calls(fetchMock,'POST /api/obligations')).toEqual([]);
 });

 it.each([
  ['the creator (self-approval)',{...full,currentUserId:'creator'},'You created this invoice, so someone else must approve it.'],
  ['a user without invoice.approve',{...full,canApprove:false},'You do not have permission to approve invoices.'],
  ['a user missing obligation.confirm',{...full,canConfirmObligation:false},'Approval also needs permission to confirm obligations and create journals.'],
  ['a user missing accounting.journal.create',{...full,canCreateJournal:false},'Approval also needs permission to confirm obligations and create journals.'],
 ])('disables approval for %s and explains why',async(_name,userCaps,message)=>{
  const fetchMock=mockApi(submitted);
  render(<InvoiceWorkspace {...userCaps} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-9'));
  const button=await screen.findByRole('button',{name:'Approve invoice'});
  expect(button).toBeDisabled();
  expect(screen.getByTestId('next-action-note')).toHaveTextContent(message);
  fireEvent.click(button);
  expect(calls(fetchMock,'/approve')).toEqual([]);
 });

 it('shows a mapped message for approval failures',async()=>{
  mockApi(submitted,(key)=>key===`POST /api/invoices/${ID}/approve`?json({error:'x',code:'INVOICE_MAPPING_MISSING'},409):undefined);
  render(<InvoiceWorkspace {...full} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-9'));
  fireEvent.click(await screen.findByRole('button',{name:'Approve invoice'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('A required account mapping is missing or inactive. Complete it before approving.');
 });

 it('shows number, obligation, journal, VAT, paid and outstanding for an approved invoice',async()=>{
  mockApi(approved);
  render(<InvoiceWorkspace {...full} direction="purchase" onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('PINV-0001'));
  const finance=await screen.findByRole('region',{name:'Financial status'});
  const text=finance.textContent??'';
  for(const part of ['PINV-0001','Linked','Draft (not posted)','Reviewed','15.00 SAR','100.00 SAR'])expect(text).toContain(part);
 });

 it('requires an explicit confirmation before posting the journal and never posts on its own',async()=>{
  const fetchMock=mockApi(approved,(key)=>key===`POST /api/accounting/journals/${JOURNAL}/post`?json({id:JOURNAL,status:'posted'}):undefined);
  render(<InvoiceWorkspace {...full} direction="purchase" onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('PINV-0001'));
  expect(calls(fetchMock,'/post')).toEqual([]);
  fireEvent.click(await screen.findByRole('button',{name:'Post journal'}));
  expect(await screen.findByText('Post this journal?')).toBeInTheDocument();
  expect(calls(fetchMock,'/post')).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
  expect(screen.queryByText('Post this journal?')).not.toBeInTheDocument();
  expect(calls(fetchMock,'/post')).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Post journal'}));
  const before=calls(fetchMock,`GET /api/invoices/${ID}`).length;
  fireEvent.click(within(screen.getByRole('group',{name:'Post this journal?'})).getByRole('button',{name:'Post journal'}));
  await waitFor(()=>expect(calls(fetchMock,`POST /api/accounting/journals/${JOURNAL}/post`).length).toBe(1));
  expect((calls(fetchMock,'/post')[0]![1] as RequestInit).body).toBe('{}');
  // the financial state is re-read from the server after posting
  await waitFor(()=>expect(calls(fetchMock,`GET /api/invoices/${ID}`).length).toBeGreaterThan(before));
 });

 it('maps posting failures to safe messages and keeps the invoice open',async()=>{
  mockApi(approved,(key)=>key===`POST /api/accounting/journals/${JOURNAL}/post`?json({error:'raw',code:'ACCOUNTING_PERIOD_CLOSED'},409):undefined);
  render(<InvoiceWorkspace {...full} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('PINV-0001'));
  fireEvent.click(await screen.findByRole('button',{name:'Post journal'}));
  fireEvent.click(within(screen.getByRole('group',{name:'Post this journal?'})).getByRole('button',{name:'Post journal'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('The accounting period of this journal is closed.');
  expect(screen.queryByText('raw')).not.toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
 });

 it('disables posting without accounting.journal.post and says why',async()=>{
  mockApi(approved);
  render(<InvoiceWorkspace {...full} canPostJournal={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('PINV-0001'));
  expect(await screen.findByRole('button',{name:'Post journal'})).toBeDisabled();
  expect(screen.getByTestId('next-action-note')).toHaveTextContent('You do not have permission to post journals.');
 });

 it('offers no further financial action once posted, and explains that settlement is never automatic',async()=>{
  mockApi({...approved,journal:{id:JOURNAL,status:'posted'},actionable_status:'partially_settled'});
  render(<InvoiceWorkspace {...full} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('PINV-0001'));
  expect(await screen.findByTestId('next-action-note')).toHaveTextContent('The journal is posted. Record the collection or payment from here; it is never done automatically.');
  expect(screen.queryByRole('button',{name:'Post journal'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Approve invoice'})).not.toBeInTheDocument();
 });
});

describe('Contextual navigation',()=>{
 it('opens the exact obligation, journal and VAT page with query state, only when authorized',async()=>{
  mockApi(approved);
  const onNavigate=vi.fn();
  render(<InvoiceWorkspace {...full} direction="purchase" onNavigate={onNavigate} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('PINV-0001'));
  fireEvent.click(await screen.findByRole('button',{name:'Open obligation'}));
  fireEvent.click(screen.getByRole('button',{name:'Open journal'}));
  fireEvent.click(screen.getByRole('button',{name:'Open VAT page'}));
  expect(onNavigate.mock.calls).toEqual([['obligations',{obligationId:OBLIGATION}],['accounting',{accountingTab:'journals',journalId:JOURNAL}],['vat',{}]]);
 });

 it('hides links to pages the user cannot open and links nothing that does not exist',async()=>{
  mockApi({...approved,journal:null,obligation:null,vat:{status:'missing',review_id:null,tax_date:null}});
  render(<InvoiceWorkspace {...full} onNavigate={vi.fn()} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('PINV-0001'));
  await screen.findByRole('region',{name:'Financial status'});
  for(const name of ['Open obligation','Open journal','Open VAT page'])expect(screen.queryByRole('button',{name})).not.toBeInTheDocument();
 });

 it('links the evidence document file only with document.view',async()=>{
  mockApi({...base,source_document_id:DOC});
  const {unmount}=render(<InvoiceWorkspace {...caps} canViewDocuments onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-9'));
  expect(await screen.findByRole('link',{name:'Open document'})).toHaveAttribute('href',`/api/documents/${DOC}/file`);
  unmount();
  mockApi({...base,source_document_id:DOC});
  render(<InvoiceWorkspace {...caps} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-9'));
  await screen.findByRole('dialog');
  expect(screen.queryByRole('link',{name:'Open document'})).not.toBeInTheDocument();
 });
});

describe('Purchases page',()=>{
 it('shows the purchase invoice workspace for invoice permissions alone, without the legacy document section',async()=>{
  const fetchMock=mockApi();
  render(<Purchases canView={false} canManage={false} invoices={caps} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByRole('heading',{name:'Purchase invoices'})).toBeInTheDocument();
  await screen.findByText('REF-9');
  expect(lastList(fetchMock).get('direction')).toBe('purchase');
  expect(calls(fetchMock,'/api/purchases')).toEqual([]);
 });
});

describe('Invoice and legacy sections',()=>{
 it('Purchases separates the invoice workspace from legacy documents with tabs, persisted in the URL',async()=>{
  vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(url.startsWith('/api/purchases')?json({purchases:[]}):url.startsWith('/api/invoices/customers')?json({suppliers:[]}):url.startsWith('/api/invoices')?json({invoices:[],total:0,limit:25,offset:0}):json({}))));
  render(<Purchases canView canManage invoices={caps} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByRole('heading',{name:'Purchase invoices'})).toBeInTheDocument();
  expect(screen.getByRole('tab',{name:'Invoices'})).toHaveAttribute('aria-selected','true');
  fireEvent.click(screen.getByRole('tab',{name:'Legacy documents'}));
  await waitFor(()=>expect(screen.queryByRole('heading',{name:'Purchase invoices'})).not.toBeInTheDocument());
  expect(new URL(window.location.href).searchParams.get('purchaseTab')).toBe('legacy');
  fireEvent.click(screen.getByRole('tab',{name:'Invoices'}));
  expect(await screen.findByRole('heading',{name:'Purchase invoices'})).toBeInTheDocument();
  expect(new URL(window.location.href).searchParams.get('purchaseTab')).toBeNull();
 });
 it('shows no tabs when the user has only one kind of access',async()=>{
  mockApi();
  render(<Purchases canView={false} canManage={false} invoices={caps} onUnauthorized={vi.fn()}/>);
  await screen.findByText('REF-9');
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
 });
});

describe('Arabic RTL',()=>{
 it('renders the purchase workspace and the posting confirmation in Arabic',async()=>{
  await i18n.changeLanguage('ar');
  mockApi(approved);
  render(<InvoiceWorkspace {...full} direction="purchase" onUnauthorized={vi.fn()}/>);
  expect(await screen.findByRole('heading',{name:'فواتير المشتريات'})).toBeInTheDocument();
  fireEvent.click(await screen.findByText('PINV-0001'));
  fireEvent.click(await screen.findByRole('button',{name:'ترحيل القيد'}));
  expect(await screen.findByText('ترحيل هذا القيد؟')).toBeInTheDocument();
  await i18n.changeLanguage('en');
 });
});

describe('Shared Dialog behavior',()=>{
 it('renders in a body portal, locks background scroll, traps Tab focus and restores focus and scroll',async()=>{
  document.body.style.overflow='auto';
  function Harness(){const[open,setOpen]=useOpen();return <main><button onClick={()=>setOpen(true)}>Opener</button>{open&&<Dialog title="T" size="wide" onClose={()=>setOpen(false)}><button>First</button><button>Last</button></Dialog>}</main>}
  const{container}=render(<Harness/>);
  const opener=screen.getByRole('button',{name:'Opener'});
  opener.focus();fireEvent.click(opener);
  const dialog=await screen.findByRole('dialog');
  expect(container.contains(dialog)).toBe(false);
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  expect(dialog).toHaveClass('modal','modal--wide');
  expect(document.body.style.overflow).toBe('hidden');
  const first=screen.getByRole('button',{name:'First'}),last=screen.getByRole('button',{name:'Last'});
  await waitFor(()=>expect(first).toHaveFocus());
  last.focus();fireEvent.keyDown(document,{key:'Tab'});
  expect(first).toHaveFocus();
  fireEvent.keyDown(document,{key:'Tab',shiftKey:true});
  expect(last).toHaveFocus();
  fireEvent.keyDown(document,{key:'Escape'});
  await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(document.body.style.overflow).toBe('auto');
  expect(opener).toHaveFocus();
 });

 it('keeps background scroll locked until the last of several dialogs closes',async()=>{
  function Two({showB}:{showB:boolean}){return <><Dialog title="A" onClose={()=>undefined}><button>a</button></Dialog>{showB&&<Dialog title="B" onClose={()=>undefined}><button>b</button></Dialog>}</>}
  const{rerender}=render(<Two showB/>);
  expect(document.body.style.overflow).toBe('hidden');
  rerender(<Two showB={false}/>);
  expect(document.body.style.overflow).toBe('hidden');
  rerender(<></>);
  expect(document.body.style.overflow).toBe('');
  await act(async()=>undefined);
 });
});

describe('Workflow decision logic',()=>{
 const inv=(over:Record<string,unknown>)=>({status:'submitted' as const,created_by_user_id:'a',obligation:null,journal:null,...over});
 it('picks exactly one next action per stage',()=>{
  expect(nextAction(inv({status:'draft'}),{...caps})).toEqual({kind:'submit',enabled:true,reason:null});
  expect(nextAction(inv({}),{...full})).toEqual({kind:'approve',enabled:true,reason:null});
  expect(nextAction(inv({status:'approved',journal:{id:'j',status:'draft'}}),{...full})).toEqual({kind:'post',enabled:true,reason:null});
  expect(nextAction(inv({status:'approved',journal:{id:'j',status:'posted'}}),{...full})).toEqual({kind:'none',enabled:false,reason:'posted'});
  expect(nextAction(inv({status:'approved',journal:null}),{...full})).toEqual({kind:'post',enabled:false,reason:'noJournal'});
  expect(nextAction(inv({status:'cancelled'}),{...full}).kind).toBe('none');
  expect(nextAction(inv({status:'approved',obligation:{id:'o',is_cancelled:true},journal:{id:'j',status:'draft'}}),{...full}).reason).toBe('cancelled');
 });
 it('sums decimal strings exactly',()=>{
  expect(sumDecimalStrings(['0.10','0.20','0.30'])).toBe('0.60');
  expect(sumDecimalStrings(['1234.5',null,'bad','-0.05'])).toBe('1234.45');
  expect(sumDecimalStrings([])).toBe('0.00');
 });
});

import {useState} from 'react';
function useOpen():[boolean,(value:boolean)=>void]{return useState(false)}

describe('F4 cancellation and correction history',()=>{
 const submittedInvoice={...base,status:'submitted',actionable_status:'awaiting_approval'};
 const cancelled={...base,status:'cancelled',actionable_status:'cancelled',cancellation:{cancelled_by_user_id:'u',cancelled_at:'2026-10-13T08:00:00Z',reason:'Issued by mistake'},adjustments:[]};
 const open=async(invoice:Record<string,unknown>,capabilities:Record<string,unknown>,extra:Handler=()=>undefined,label:string='REF-9')=>{
  const fetchMock=mockApi(invoice,extra);
  render(<InvoiceWorkspace {...capabilities as typeof caps} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText(label));
  await screen.findByRole('dialog');
  return fetchMock;
 };

 it('hides the cancel button without invoice.cancel and offers it for draft and submitted invoices with it',async()=>{
  await open(base,caps);
  expect(screen.queryByRole('button',{name:'Cancel invoice'})).not.toBeInTheDocument();
  cleanup();
  await open(submittedInvoice,{...caps,canCancel:true});
  expect(screen.getByRole('button',{name:'Cancel invoice'})).toBeInTheDocument();
  cleanup();
  await open(base,{...caps,canCancel:true});
  expect(screen.getByRole('button',{name:'Cancel invoice'})).toBeInTheDocument();
 });

 it('requires a reason, then sends the version and the reason once and reloads the invoice',async()=>{
  const fetchMock=await open(submittedInvoice,{...caps,canCancel:true},(key)=>key===`POST /api/invoices/${ID}/cancel`?json({invoice:cancelled}):undefined);
  fireEvent.click(screen.getByRole('button',{name:'Cancel invoice'}));
  const group=await screen.findByRole('group',{name:'Cancel this invoice?'});
  const confirm=within(group).getByRole('button',{name:'Cancel invoice'});
  expect(confirm).toBeDisabled();
  fireEvent.change(within(group).getByLabelText('Cancellation reason'),{target:{value:'Issued by mistake'}});
  fireEvent.click(confirm);
  await waitFor(()=>expect(calls(fetchMock,`POST /api/invoices/${ID}/cancel`).length).toBe(1));
  const body=JSON.parse((calls(fetchMock,'/cancel')[0]![1] as RequestInit).body as string);
  expect(body).toEqual({version:base.version,reason:'Issued by mistake'});
 });

 it('shows the cancellation reason in the correction history and offers no further action',async()=>{
  await open(cancelled,{...caps,canCancel:true});
  const history=await screen.findByTestId('correction-history');
  expect(within(history).getByText('Issued by mistake')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Cancel invoice'})).not.toBeInTheDocument();
  expect(screen.getByTestId('next-action-note')).toHaveTextContent('cancelled');
 });

 it('never offers cancelling an approved invoice, explains the credit/debit note route and lists existing notes',async()=>{
  const withNote={...approved,adjustments:[{id:'a1',adjustment_type:'credit',status:'draft',adjustment_date:'2026-10-05',total_amount:'115.00',reason:'Returned goods'}]};
  await open(withNote,{...full,canCancel:true},()=>undefined,'PINV-0001');
  expect(screen.queryByRole('button',{name:'Cancel invoice'})).not.toBeInTheDocument();
  expect(screen.getByTestId('correction-hint')).toHaveTextContent('credit or debit note');
  const list=await screen.findByTestId('invoice-adjustments');
  expect(within(list).getByText(/Credit note/)).toBeInTheDocument();
  expect(within(list).getByText(/Returned goods/)).toBeInTheDocument();
 });

 it('shows the server rejection in Arabic and keeps the invoice open',async()=>{
  await i18n.changeLanguage('ar');
  await open(submittedInvoice,{...caps,canCancel:true},(key)=>key===`POST /api/invoices/${ID}/cancel`?json({error:'x',code:'INVOICE_CANCEL_NOT_ALLOWED'},409):undefined);
  fireEvent.click(screen.getByRole('button',{name:'إلغاء الفاتورة'}));
  const group=await screen.findByRole('group',{name:'إلغاء هذه الفاتورة؟'});
  fireEvent.change(within(group).getByLabelText('سبب الإلغاء'),{target:{value:'خطأ'}});
  fireEvent.click(within(group).getByRole('button',{name:'إلغاء الفاتورة'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('لا يمكن إلغاء فاتورة معتمدة');
 });
});
