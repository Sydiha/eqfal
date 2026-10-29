import {fireEvent,render,screen,waitFor,within} from './test-utils';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import i18n from '../i18n';
import {InvoiceWorkspace} from '../components/SalesInvoices';
import {Obligations} from '../components/Obligations';
import {settlementAction} from '../components/invoiceWorkspaceLogic';
import {classifyBankTransactions,sanitizeReturnQuery} from '../components/obligationSettlementLogic';

// F3: contextual collection/payment for invoices. Settlement itself is the existing obligation mechanism; these tests cover
// what the UI offers, the context it carries and the explanations it gives. The server remains the authority.
const INV='11111111-1111-4111-8111-111111111111',OB='33333333-3333-4333-8333-333333333333',JR='44444444-4444-4444-8444-444444444444',PARTY='22222222-2222-4222-8222-222222222222';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const invoice=(over:Record<string,unknown>={})=>({id:INV,status:'approved',counterparty_id:PARTY,counterparty_name:'Gulf',internal_number:'INV-1',external_reference:null,issue_date:'2026-10-01',due_date:null,supply_date:null,tax_point_date:'2026-10-01',currency:'SAR',subtotal_amount:'1000.00',vat_amount:'150.00',total_amount:'1150.00',notes:null,version:3,created_by_user_id:'u',lines:[],obligation:{id:OB,is_cancelled:false,original_amount:'1150.00'},journal:{id:JR,status:'posted'},vat:{status:'reviewed',review_id:'r',tax_date:'2026-10-01'},paid_amount:'400.00',outstanding_amount:'750.00',actionable_status:'partially_settled',settlements:[{id:'s1',bank_transaction_id:'b1',amount:'400.00',transaction_date:'2026-10-05',description:'First transfer',note:null}],...over});
const caps={canView:true,canCreate:false,canEdit:false,canSubmit:false,canViewObligations:true,canCreateSettlement:true};
function mockInvoices(inv:Record<string,unknown>){
 const f=vi.fn((url:string)=>{const path=url.split('?')[0];
  if(path==='/api/invoices')return Promise.resolve(json({invoices:[inv],total:1,limit:25,offset:0}));
  if(path===`/api/invoices/${INV}`)return Promise.resolve(json({invoice:inv}));
  if(path==='/api/invoices/customers')return Promise.resolve(json({customers:[],suppliers:[]}));
  return Promise.resolve(json({},404))});
 vi.stubGlobal('fetch',f);return f}
beforeEach(async()=>{vi.restoreAllMocks();window.history.replaceState(null,'','/?page=sales');await i18n.changeLanguage('en')});

describe('Invoice side: Record collection / Record payment',()=>{
 it('sales offers "Record collection" for the linked obligation and carries invoice context, filters included',async()=>{
  window.history.replaceState(null,'','/?page=sales&salesInvStatus=approved&other=x');
  mockInvoices(invoice());const onNavigate=vi.fn();
  render(<InvoiceWorkspace {...caps} direction="sales" onNavigate={onNavigate} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('INV-1'));
  const button=await screen.findByRole('button',{name:'Record collection'});expect(button).toBeEnabled();
  expect(screen.queryByRole('button',{name:'Record payment'})).not.toBeInTheDocument();
  fireEvent.click(button);
  expect(onNavigate).toHaveBeenCalledWith('obligations',{obligationId:OB,settle:'1',returnPage:'sales',returnInvoice:INV,returnQuery:'salesInvStatus=approved'});
 });
 it('purchases offers "Record payment" and returns to purchases',async()=>{
  window.history.replaceState(null,'','/?page=purchases');
  mockInvoices(invoice());const onNavigate=vi.fn();
  render(<InvoiceWorkspace {...caps} direction="purchase" onNavigate={onNavigate} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('INV-1'));
  fireEvent.click(await screen.findByRole('button',{name:'Record payment'}));
  expect(onNavigate).toHaveBeenCalledWith('obligations',{obligationId:OB,settle:'1',returnPage:'purchases',returnInvoice:INV});
 });
 it('shows server totals and the settlement history, not a client-computed balance',async()=>{
  mockInvoices(invoice({paid_amount:'400.00',outstanding_amount:'123.45'}));
  render(<InvoiceWorkspace {...caps} onNavigate={vi.fn()} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('INV-1'));
  const list=await screen.findByTestId('invoice-settlements');
  expect(within(list).getByText('First transfer')).toBeInTheDocument();expect(within(list).getByText(/400\.00 SAR/)).toBeInTheDocument();
  expect(within(screen.getByRole('region',{name:'Financial status'})).getByText('123.45 SAR')).toBeInTheDocument();
  // The same server value heads the dialog summary; nothing is recomputed on the client.
  expect(within(screen.getByRole('group',{name:'Invoice summary'})).getByText('123.45 SAR')).toBeInTheDocument();
 });
 it.each([
  ['journal not posted',{journal:{id:JR,status:'draft'}},caps,'Post the journal first'],
  ['missing obligation.settlement.create',{},{...caps,canCreateSettlement:false},'do not have permission to record'],
  ['nothing outstanding',{outstanding_amount:'0.00'},caps,'Nothing is outstanding'],
 ])('disables the action and explains why: %s',async(_name,over,c,text)=>{
  mockInvoices(invoice(over as Record<string,unknown>));
  render(<InvoiceWorkspace {...c} onNavigate={vi.fn()} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('INV-1'));
  const note=await screen.findByTestId('settle-note');expect(note).toHaveTextContent(text);
  const b=screen.queryByRole('button',{name:'Record collection'});if(b)expect(b).toBeDisabled();
 });
 it('offers no settlement action before approval (the next-action note covers approval)',async()=>{
  mockInvoices(invoice({status:'submitted',obligation:null,journal:null,paid_amount:null,outstanding_amount:null}));
  render(<InvoiceWorkspace {...caps} onNavigate={vi.fn()} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('INV-1'));
  await screen.findByRole('button',{name:'Close'});expect(screen.queryByRole('button',{name:'Record collection'})).not.toBeInTheDocument();expect(screen.queryByTestId('settle-note')).not.toBeInTheDocument();
 });
 it('offers nothing on a cancelled invoice',async()=>{
  mockInvoices(invoice({status:'cancelled'}));
  render(<InvoiceWorkspace {...caps} onNavigate={vi.fn()} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('INV-1'));
  await screen.findByRole('button',{name:'Close'});expect(screen.queryByRole('button',{name:'Record collection'})).not.toBeInTheDocument();
 });
 it('reopens exactly the returned invoice once and clears the parameter',async()=>{
  window.history.replaceState(null,'',`/?page=sales&invoiceId=${INV}`);
  const f=mockInvoices(invoice());
  render(<InvoiceWorkspace {...caps} onNavigate={vi.fn()} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).has('invoiceId')).toBe(false);
  expect(f.mock.calls.filter(c=>String(c[0])===`/api/invoices/${INV}`)).toHaveLength(1);
 });
 it('ignores a malformed invoiceId',async()=>{
  window.history.replaceState(null,'','/?page=sales&invoiceId=not-a-uuid');
  const f=mockInvoices(invoice());
  render(<InvoiceWorkspace {...caps} onNavigate={vi.fn()} onUnauthorized={vi.fn()}/>);
  await screen.findByText('INV-1');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(f.mock.calls.some(c=>String(c[0]).includes('not-a-uuid'))).toBe(false);
 });
});

describe('settlementAction / classifyBankTransactions / sanitizeReturnQuery',()=>{
 it('keeps approval, posting and settlement separate',()=>{
  const ok={status:'approved' as const,obligation:{id:OB,is_cancelled:false},journal:{id:JR,status:'posted'},outstanding_amount:'10.00'};
  expect(settlementAction(ok,caps)).toEqual({enabled:true,reason:null});
  expect(settlementAction({...ok,journal:{id:JR,status:'draft'}},caps).reason).toBe('settleNotPosted');
  expect(settlementAction({...ok,journal:null},caps).reason).toBe('settleNotPosted');
  expect(settlementAction({...ok,status:'submitted' as const},caps).reason).toBe('settleNotApproved');
  expect(settlementAction({...ok,obligation:{id:OB,is_cancelled:true}},caps).reason).toBe('cancelled');
  expect(settlementAction(ok,{...caps,canCreateSettlement:false}).reason).toBe('noSettle');
  expect(settlementAction(ok,{...caps,canViewObligations:false}).reason).toBe('noViewObligations');
 });
 const tx=(id:string,amount:string,status='unmatched')=>({id,transaction_date:'2026-10-01',description:null,bank_reference:null,amount,reconciliation_status:status});
 it('explains every ineligible transaction and respects direction',()=>{
  const list=[tx('ok','100.00'),tx('debit','-100.00'),tx('used','100.00'),tx('matched','100.00','matched'),tx('big','900.00'),tx('zero','0.00')];
  const r=classifyBankTransactions(list,{direction:'receivable',remainingAmount:'750.00',usedTransactionIds:new Set(['used'])});
  expect(r.eligible.map(x=>x.id)).toEqual(['ok']);
  expect(Object.fromEntries(r.ineligible.map(x=>[x.transaction.id,x.reason]))).toEqual({debit:'wrongDirection',used:'alreadySettled',matched:'notUnmatched',big:'exceedsOutstanding',zero:'wrongDirection'});
  const p=classifyBankTransactions([tx('pay','-750.00'),tx('credit','10.00')],{direction:'payable',remainingAmount:'750.00',usedTransactionIds:new Set()});
  expect(p.eligible.map(x=>x.id)).toEqual(['pay']);expect(p.ineligible[0]!.reason).toBe('wrongDirection');
 });
 it('exact cents against the remaining balance',()=>{
  const r=classifyBankTransactions([tx('a','350.00'),tx('b','350.01')],{direction:'receivable',remainingAmount:'350.00',usedTransactionIds:new Set()});
  expect(r.eligible.map(x=>x.id)).toEqual(['a']);expect(r.ineligible[0]!.reason).toBe('exceedsOutstanding');
 });
 it('keeps only the originating workspace filters when returning',()=>{
  expect(sanitizeReturnQuery('salesInvStatus=approved&salesInvQ=acme&purchaseInvQ=x&page=admin&evil=1','sales')).toEqual({salesInvStatus:'approved',salesInvQ:'acme'});
  expect(sanitizeReturnQuery('salesInvQ=x','purchases')).toEqual({});
  expect(sanitizeReturnQuery(null,'sales')).toEqual({});
 });
});

describe('Obligation side: preselected settlement dialog',()=>{
 const ob=(over:Record<string,unknown>={})=>({id:OB,direction:'receivable',counterparty_id:'c1',counterparty_name:'Gulf',source_type:'invoice',invoice_id:INV,original_amount:'1150.00',settled_amount:'400.00',remaining_amount:'750.00',recognized_on:'2026-10-01',due_on:null,verification_status:'confirmed',state:'partial',is_overdue:false,is_cancelled:false,document_id:null,source_note:null,version:2,settlement_history:[{id:'s1',bank_transaction_id:'b1',amount:'400.00',note:null,transaction_date:'2026-10-05',description:'First transfer'}],...over});
 const data=(o=ob())=>({obligations:[o],eligible_documents:[],summary:{open_receivables:'750.00',open_payables:'0.00',unconfirmed_receivables:'0.00',unconfirmed_payables:'0.00',unconfirmed_count:0,partially_settled_count:1,overdue_count:0}});
 const txs=[{id:'b1',transaction_date:'2026-10-05',description:'First transfer',bank_reference:null,amount:'400.00',reconciliation_status:'unmatched'},{id:'b2',transaction_date:'2026-10-20',description:'Second transfer',bank_reference:null,amount:'300.00',reconciliation_status:'unmatched'},{id:'b3',transaction_date:'2026-10-21',description:'Outgoing',bank_reference:null,amount:'-300.00',reconciliation_status:'unmatched'},{id:'b4',transaction_date:'2026-10-22',description:'Too large',bank_reference:null,amount:'900.00',reconciliation_status:'unmatched'}];
 function mock(first=data(),after:ReturnType<typeof data>|null=null,post:()=>Response=()=>json({id:'new'},201)){
  let posted=false;
  const f=vi.fn((url:string,init?:RequestInit)=>{
   if(url==='/api/obligations'&&(init?.method??'GET')==='GET')return Promise.resolve(json(posted&&after?after:first));
   if(url==='/api/counterparties')return Promise.resolve(json({counterparties:[{id:'c1',name:'Gulf',type:'customer',is_active:true,version:1}]}));
   if(url==='/api/bank-transactions')return Promise.resolve(json({transactions:txs}));
   if(url===`/api/obligations/${OB}/settlements`){posted=true;return Promise.resolve(post())}
   return Promise.resolve(json({},404))});
  vi.stubGlobal('fetch',f);return f}
 const url=(extra='')=>window.history.replaceState(null,'',`/?page=obligations&obligationId=${OB}&settle=1&returnPage=sales&returnInvoice=${INV}&returnQuery=${encodeURIComponent('salesInvStatus=approved')}${extra}`);
 it('opens the exact obligation with the collection dialog, only eligible transactions selectable, reasons for the rest',async()=>{
  url();mock();
  render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()} onReturnToInvoice={vi.fn()}/>);
  const dialog=await screen.findByRole('dialog',{name:'Record collection'});
  const select=within(dialog).getByLabelText('Bank transaction');
  expect(within(select).getAllByRole('option').map(o=>o.textContent)).toEqual(['Select an eligible bank transaction',expect.stringContaining('Second transfer')]);
  expect(within(dialog).getByTestId('settlement-summary')).toHaveTextContent('750.00');
  fireEvent.click(within(dialog).getByText(/Not eligible \(3\)/));
  expect(within(dialog).getByText('Already used to settle an obligation.')).toBeInTheDocument();
  expect(within(dialog).getByText(/Wrong direction/)).toBeInTheDocument();
  expect(within(dialog).getByText('Amount is larger than the remaining balance.')).toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).has('settle')).toBe(false);
 });
 it('posts the whole bank transaction to the existing endpoint, then refreshes server data without recomputing',async()=>{
  url();const f=mock(data(),data(ob({settled_amount:'700.00',remaining_amount:'450.00',settlement_history:[]})));
  render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()} onReturnToInvoice={vi.fn()}/>);
  const dialog=await screen.findByRole('dialog',{name:'Record collection'});
  fireEvent.change(within(dialog).getByLabelText('Bank transaction'),{target:{value:'b2'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const post=f.mock.calls.find(c=>c[0]===`/api/obligations/${OB}/settlements`)!;
  expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({bank_transaction_id:'b2',amount:'300.00',note:null});
  expect(f.mock.calls.filter(c=>c[0]==='/api/obligations'&&((c[1] as RequestInit|undefined)?.method??'GET')==='GET').length).toBe(2);
  await waitFor(()=>expect(screen.getAllByText('450.00').length).toBeGreaterThan(0));
 });
 it('keeps the dialog open with a reason when the server rejects (duplicate, overpayment, closed period, unposted journal)',async()=>{
  url();mock(data(),null,()=>json({error:'Conflict'},409));
  render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()} onReturnToInvoice={vi.fn()}/>);
  const dialog=await screen.findByRole('dialog',{name:'Record collection'});
  fireEvent.change(within(dialog).getByLabelText('Bank transaction'),{target:{value:'b2'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'Save'}));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('The settlement was rejected');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
 });
 it.each([
  ['ACCOUNTING_PERIOD_CLOSED',409,'This action is not allowed because the accounting period is closed.'],
  ['FORBIDDEN',403,'You do not have permission for this action.'],
])('shows the localized message for %s and never the raw server text',async(code,status,text)=>{
  url();mock(data(),null,()=>json({error:'RAW SERVER TEXT',code},status));
  render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()} onReturnToInvoice={vi.fn()}/>);
  const dialog=await screen.findByRole('dialog',{name:'Record collection'});
  fireEvent.change(within(dialog).getByLabelText('Bank transaction'),{target:{value:'b2'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'Save'}));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
  expect(screen.queryByText('RAW SERVER TEXT')).not.toBeInTheDocument();
 });
 it('reports a network failure while saving a settlement with the connection message',async()=>{
  url();mock(data(),null,()=>{throw new TypeError('Failed to fetch');});
  render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()} onReturnToInvoice={vi.fn()}/>);
  const dialog=await screen.findByRole('dialog',{name:'Record collection'});
  fireEvent.change(within(dialog).getByLabelText('Bank transaction'),{target:{value:'b2'}});
  fireEvent.click(within(dialog).getByRole('button',{name:'Save'}));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not connect to the server');
 });
 it('payable obligations say "Record payment" and accept only debits',async()=>{
  url();mock(data(ob({direction:'payable'})));
  render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()}/>);
  const dialog=await screen.findByRole('dialog',{name:'Record payment'});
  const select=within(dialog).getByLabelText('Bank transaction');
  expect(within(select).getAllByRole('option').map(o=>o.textContent).join('|')).toContain('Outgoing');
  expect(within(select).queryByText(/Second transfer/)).not.toBeInTheDocument();
 });
 it('does not open the dialog without obligation.settlement.create, or for a cancelled or fully settled obligation',async()=>{
  url();mock();const first=render(<Obligations canView onUnauthorized={vi.fn()}/>);
  await screen.findByRole('complementary');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();first.unmount();
  url();mock(data(ob({is_cancelled:true})));const second=render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()}/>);
  await screen.findByRole('complementary');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();second.unmount();
  url();mock(data(ob({remaining_amount:'0.00',state:'settled'})));render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()}/>);
  await screen.findByRole('complementary');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 });
 it('Return to invoice goes back to the exact invoice with its filters',async()=>{
  url();mock();const onReturn=vi.fn();
  render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()} onReturnToInvoice={onReturn}/>);
  const dialog=await screen.findByRole('dialog',{name:'Record collection'});
  fireEvent.click(within(dialog).getByRole('button',{name:'Return to invoice'}));
  expect(onReturn).toHaveBeenCalledWith('sales',{salesInvStatus:'approved',invoiceId:INV});
 });
 it('rejects tampered return context',async()=>{
  window.history.replaceState(null,'',`/?page=obligations&obligationId=${OB}&returnPage=admin&returnInvoice=${INV}`);
  mock();render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()} onReturnToInvoice={vi.fn()}/>);
  await screen.findByRole('complementary');expect(screen.queryByRole('button',{name:'Return to invoice'})).not.toBeInTheDocument();
 });
 it('says so when the linked obligation is not in this company',async()=>{
  window.history.replaceState(null,'','/?page=obligations&obligationId=55555555-5555-4555-8555-555555555555&settle=1');
  mock();render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()}/>);
  expect(await screen.findByText('The linked obligation was not found in this company.')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 });
 it('renders the Arabic labels',async()=>{
  await i18n.changeLanguage('ar');url();mock();
  render(<Obligations canView canCreateSettlement onUnauthorized={vi.fn()} onReturnToInvoice={vi.fn()}/>);
  expect(await screen.findByRole('dialog',{name:'تسجيل تحصيل'})).toBeInTheDocument();
  expect(screen.getAllByRole('button',{name:'العودة إلى الفاتورة'})).toHaveLength(2);
 });
});
