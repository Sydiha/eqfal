import {fireEvent,render,screen,waitFor} from './test-utils';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import i18n from '../i18n';
import {InvoiceNotes} from '../components/InvoiceNotes';

// External credit/debit notes UI: collects raw inputs only. The server computes VAT/totals and decides every rule.
const INV='11111111-1111-4111-8111-111111111111',N1='55555555-5555-4555-8555-555555555555';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const note=(over:Record<string,unknown>={})=>({id:N1,adjustment_type:'credit',status:'draft',adjustment_date:'2026-03-20',external_number:'CN-7',reason:'Returned goods',subtotal_amount:'100.00',vat_amount:'15.00',total_amount:'115.00',version:1,journal_id:null,journal_status:null,...over});
const props={invoiceId:INV,purchase:false,currency:'SAR',canAdjust:true,canApprove:true,onChanged:vi.fn(),onUnauthorized:vi.fn()};
function mock(notes:unknown[],post?:(url:string,body:Record<string,unknown>)=>Response){
 const f=vi.fn((url:string,init?:RequestInit)=>{
  if(init?.method==='POST'||init?.method==='PUT')return Promise.resolve(post?post(url,JSON.parse(String(init.body))):json({}));
  return Promise.resolve(json({adjustments:notes}))});
 vi.stubGlobal('fetch',f);return f}
beforeEach(async()=>{vi.restoreAllMocks();props.onChanged.mockReset();props.onUnauthorized.mockReset();await i18n.changeLanguage('en')});

describe('InvoiceNotes',()=>{
 it('lists the registered notes with type, external number, status and server total',async()=>{
  mock([note(),note({id:'x',status:'approved',external_number:'CN-8',adjustment_type:'debit',journal_status:'draft'})]);
  render(<InvoiceNotes {...props}/>);
  expect(await screen.findByText(/Credit note CN-7 \| Draft/)).toBeInTheDocument();
  expect(screen.getByText(/Debit note CN-8 \| Approved/)).toBeInTheDocument();
  expect(screen.getAllByText('115.00 SAR')).toHaveLength(2);
 });
 it('shows the internal number beside the external number in English and Arabic, and none for historical notes',async()=>{
  mock([note({id:'a',status:'approved',internal_number:'3',journal_status:'draft'}),note({id:'b',status:'approved',external_number:'CN-OLD',internal_number:null})]);
  const view=render(<InvoiceNotes {...props}/>);
  expect(await screen.findByText(/Credit note CN-7/)).toHaveTextContent('CN-7 | Internal number: 3 | Approved');
  expect(screen.getByText(/CN-OLD/)).not.toHaveTextContent('Internal number');
  expect(screen.getAllByTestId('note-internal-number')).toHaveLength(1);
  await i18n.changeLanguage('ar');
  view.rerender(<InvoiceNotes {...props}/>);
  expect(await screen.findByText(/الرقم الداخلي/)).toHaveTextContent('CN-7');
  expect(screen.getByTestId('note-internal-number')).toHaveTextContent('3');
 });
 it('hides register/approve/cancel without the capabilities',async()=>{
  mock([note()]);
  render(<InvoiceNotes {...props} canAdjust={false} canApprove={false}/>);
  await screen.findByText(/CN-7/);
  expect(screen.queryByRole('button',{name:'Register a note'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Approve note'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Cancel draft'})).not.toBeInTheDocument();
 });
 it('registers a sales note sending raw inputs only (no VAT amount or total) and refreshes',async()=>{
  const f=mock([],(url,body)=>{expect(url).toBe(`/api/invoices/${INV}/adjustments`);expect(body).not.toHaveProperty('vat_amount');expect(body).not.toHaveProperty('total_amount');return json({adjustment:{}},201)});
  render(<InvoiceNotes {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Register a note'}));
  fireEvent.change(screen.getByLabelText('External note number'),{target:{value:'CN-9'}});
  fireEvent.change(screen.getByLabelText('Note date'),{target:{value:'2026-03-20'}});
  fireEvent.change(screen.getByLabelText('Reason'),{target:{value:'Discount'}});
  fireEvent.change(screen.getByLabelText('Description'),{target:{value:'Line'}});
  fireEvent.change(screen.getByLabelText('Net amount'),{target:{value:'100.00'}});
  expect(screen.queryByLabelText(/recover/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
  await waitFor(()=>expect(props.onChanged).toHaveBeenCalled());
  const call=f.mock.calls.find(c=>(c[1] as RequestInit|undefined)?.method==='POST')!;
  expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({adjustment_type:'credit',external_number:'CN-9',adjustment_date:'2026-03-20',reason:'Discount',lines:[{description:'Line',vat_treatment:'standard',vat_rate:'15',net_amount:'100.00'}]});
 });
 it('purchase notes require an explicit recoverability choice per standard line',async()=>{
  mock([]);
  render(<InvoiceNotes {...props} purchase/>);
  fireEvent.click(await screen.findByRole('button',{name:'Register a note'}));
  const select=screen.getByLabelText('Input VAT recovery');expect(select).toBeRequired();
  fireEvent.change(select,{target:{value:'partially_recoverable'}});
  expect(screen.getByLabelText(/Recoverable share/)).toBeRequired();
 });
 it('shows a clear message for a blocked VAT period and keeps the form',async()=>{
  mock([],()=>json({code:'INVOICE_ADJUSTMENT_VAT_PERIOD_UNSUPPORTED'},409));
  render(<InvoiceNotes {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Register a note'}));
  for(const[l,v]of[['External note number','A'],['Note date','2026-09-01'],['Reason','r'],['Description','d'],['Net amount','1.00']])fireEvent.change(screen.getByLabelText(l),{target:{value:v}});
  fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('amended VAT return');
  expect(screen.getByRole('button',{name:'Save draft'})).toBeInTheDocument();
  expect(props.onChanged).not.toHaveBeenCalled();
 });
 it('approves a draft with its version and surfaces a permission refusal',async()=>{
  const f=mock([note({version:4})],()=>json({code:'INVOICE_FORBIDDEN'},403));
  render(<InvoiceNotes {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Approve note'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission for this action.');
  const call=f.mock.calls.find(c=>(c[1] as RequestInit|undefined)?.method==='POST')!;
  expect(call[0]).toBe(`/api/invoice-adjustments/${N1}/approve`);expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({version:4});
 });
 it('cancelling a draft needs a reason',async()=>{
  const f=mock([note()],()=>json({adjustment:{}}));
  render(<InvoiceNotes {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Cancel draft'}));
  const confirm=screen.getByRole('button',{name:'Cancel note'});expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Cancellation reason'),{target:{value:'mistake'}});
  fireEvent.click(confirm);
  await waitFor(()=>expect(props.onChanged).toHaveBeenCalled());
  const call=f.mock.calls.find(c=>(c[1] as RequestInit|undefined)?.method==='POST')!;
  expect(call[0]).toBe(`/api/invoice-adjustments/${N1}/cancel`);expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({version:1,reason:'mistake'});
 });
 it('renders in Arabic',async()=>{
  await i18n.changeLanguage('ar');mock([]);
  render(<InvoiceNotes {...props}/>);
  expect(await screen.findByRole('button',{name:'تسجيل إشعار'})).toBeInTheDocument();
 });
 const approved=(over:Record<string,unknown>={})=>note({status:'approved',journal_status:'draft',version:4,internal_number:'2',...over});
 const voidCall=(f:ReturnType<typeof vi.fn>)=>f.mock.calls.find(c=>String(c[0]).endsWith('/void'))!;
 it('offers "Cancel approved note" only for an approved note with a draft journal and the invoice.adjust_void capability',async()=>{
  mock([approved({id:'a'}),approved({id:'b',external_number:'CN-P',journal_status:'posted'}),note({id:'c',external_number:'CN-D'}),approved({id:'d',external_number:'CN-X',status:'cancelled',journal_status:'voided'})]);
  const view=render(<InvoiceNotes {...props} canVoid/>);
  await screen.findByText(/CN-P/);
  expect(screen.getAllByRole('button',{name:'Cancel approved note'})).toHaveLength(1);
  expect(screen.getByText(/CN-X/).parentElement).toHaveTextContent('Voided');
  view.unmount();
  mock([approved()]);
  render(<InvoiceNotes {...props} canAdjust canApprove/>);
  await screen.findByText(/CN-7/);
  expect(screen.queryByRole('button',{name:'Cancel approved note'})).not.toBeInTheDocument();
 });
 it('needs a reason and a confirmation, then posts the current version and reason and refreshes',async()=>{
  const f=mock([approved()],()=>json({adjustment:{}}));
  render(<InvoiceNotes {...props} canVoid/>);
  fireEvent.click(await screen.findByRole('button',{name:'Cancel approved note'}));
  expect(screen.getByRole('group',{name:'Cancel this approved note?'})).toBeInTheDocument();
  const confirm=screen.getAllByRole('button',{name:'Cancel approved note'}).find(b=>b.className==='primary')!;
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Cancellation reason'),{target:{value:'  Registered twice  '}});
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);
  await waitFor(()=>expect(props.onChanged).toHaveBeenCalled());
  const call=voidCall(f);
  expect(call[0]).toBe(`/api/invoice-adjustments/${N1}/void`);
  expect((call[1] as RequestInit).method).toBe('POST');
  expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({version:4,reason:'Registered twice'});
  // details were reloaded after success and the confirmation closed
  expect(f.mock.calls.filter(c=>String(c[0]).endsWith('/adjustments')&&!(c[1] as RequestInit|undefined)?.method).length).toBeGreaterThanOrEqual(2);
  await waitFor(()=>expect(screen.queryByRole('group',{name:'Cancel this approved note?'})).not.toBeInTheDocument());
 });
 it('"Keep note" closes the confirmation without calling the server',async()=>{
  const f=mock([approved()]);
  render(<InvoiceNotes {...props} canVoid/>);
  fireEvent.click(await screen.findByRole('button',{name:'Cancel approved note'}));
  fireEvent.click(screen.getByRole('button',{name:'Keep note'}));
  expect(screen.queryByRole('group',{name:'Cancel this approved note?'})).not.toBeInTheDocument();
  expect(f.mock.calls.some(c=>(c[1] as RequestInit|undefined)?.method==='POST')).toBe(false);
 });
 it.each([
  [403,undefined,/permission|not allowed|Forbidden|could not be saved/i],
  [409,'INVOICE_ADJUSTMENT_JOURNAL_NOT_DRAFT',/already posted/],
  [409,'INVOICE_ADJUSTMENT_VOID_BLOCKED',/settlements or other approved notes/],
  [409,'INVOICE_VAT_PERIOD_CLOSED',/VAT period/i],
  [409,'INVOICE_VERSION_CONFLICT',/changed|reload/i],
  [400,'INVOICE_VALIDATION',/could not be saved/],
 ] as const)('shows a clear error and keeps the dialog open on %s %s',async(status,code,pattern)=>{
  mock([approved()],()=>json(code?{error:'x',code}:{error:'Forbidden'},status));
  render(<InvoiceNotes {...props} canVoid/>);
  fireEvent.click(await screen.findByRole('button',{name:'Cancel approved note'}));
  fireEvent.change(screen.getByLabelText('Cancellation reason'),{target:{value:'why'}});
  fireEvent.click(screen.getAllByRole('button',{name:'Cancel approved note'}).find(b=>b.className==='primary')!);
  expect(await screen.findByRole('alert')).toHaveTextContent(pattern);
  expect(props.onChanged).not.toHaveBeenCalled();
  expect(screen.getByRole('group',{name:'Cancel this approved note?'})).toBeInTheDocument();
 });
 it('signs out on 401',async()=>{
  mock([approved()],()=>json({},401));
  render(<InvoiceNotes {...props} canVoid/>);
  fireEvent.click(await screen.findByRole('button',{name:'Cancel approved note'}));
  fireEvent.change(screen.getByLabelText('Cancellation reason'),{target:{value:'why'}});
  fireEvent.click(screen.getAllByRole('button',{name:'Cancel approved note'}).find(b=>b.className==='primary')!);
  await waitFor(()=>expect(props.onUnauthorized).toHaveBeenCalled());
 });
 it('renders the action and confirmation in Arabic (RTL)',async()=>{
  await i18n.changeLanguage('ar');
  const f=mock([approved()],()=>json({adjustment:{}}));
  render(<InvoiceNotes {...props} canVoid/>);
  fireEvent.click(await screen.findByRole('button',{name:'إلغاء الإشعار المعتمد'}));
  expect(screen.getByRole('group',{name:'إلغاء هذا الإشعار المعتمد؟'})).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('سبب الإلغاء'),{target:{value:'تسجيل مكرر'}});
  fireEvent.click(screen.getAllByRole('button',{name:'إلغاء الإشعار المعتمد'}).find(b=>b.className==='primary')!);
  await waitFor(()=>expect(props.onChanged).toHaveBeenCalled());
  expect(JSON.parse(String((voidCall(f)[1] as RequestInit).body))).toEqual({version:4,reason:'تسجيل مكرر'});
 });
});
