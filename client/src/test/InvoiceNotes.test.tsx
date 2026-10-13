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
beforeEach(async()=>{vi.restoreAllMocks();props.onChanged.mockReset();await i18n.changeLanguage('en')});

describe('InvoiceNotes',()=>{
 it('lists the registered notes with type, external number, status and server total',async()=>{
  mock([note(),note({id:'x',status:'approved',external_number:'CN-8',adjustment_type:'debit',journal_status:'draft'})]);
  render(<InvoiceNotes {...props}/>);
  expect(await screen.findByText(/Credit note CN-7 \| Draft/)).toBeInTheDocument();
  expect(screen.getByText(/Debit note CN-8 \| Approved/)).toBeInTheDocument();
  expect(screen.getAllByText('115.00 SAR')).toHaveLength(2);
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
 it('approves a draft with its version and surfaces the self-approval refusal',async()=>{
  const f=mock([note({version:4})],()=>json({code:'INVOICE_SELF_APPROVAL'},403));
  render(<InvoiceNotes {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Approve note'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('someone else must approve');
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
});
