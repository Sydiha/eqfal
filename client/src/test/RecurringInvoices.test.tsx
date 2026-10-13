import {fireEvent,render,screen,waitFor} from './test-utils';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import i18n from '../i18n';
import {RecurringInvoices} from '../components/RecurringInvoices';

// Recurring schedules UI: collects raw inputs and shows server results. Every date, amount and VAT rule is decided by the server.
const T1='66666666-6666-4666-8666-666666666666',CP='22222222-2222-4222-8222-222222222222';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const line={line_number:1,description:'Monthly service',quantity:'1.0000',unit_price:'1000.00',discount_amount:'0.00',vat_rate:'15.00',vat_treatment:'standard',treatment_note:null,vat_recoverability:null,vat_recoverable_percent:null};
const tpl=(over:Record<string,unknown>={})=>({id:T1,direction:'sales',name:'Office rent',counterparty_id:CP,counterparty_name:'Customer A',frequency:'monthly',start_date:'2031-01-31',end_date:null,next_run_date:'2031-02-28',status:'active',due_days:30,notes:null,last_generated_for:'2031-01-31',last_error_code:null,version:3,lines:[line],generated_invoices:[{id:'i1',internal_number:null,status:'draft',occurrence_date:'2031-01-31',total_amount:'1150.00'}],...over});
const props={direction:'sales' as const,canManage:true,canGenerate:true,onChanged:vi.fn(),onUnauthorized:vi.fn()};
function mock(templates:unknown[],write?:(url:string,method:string,body:Record<string,unknown>)=>Response){
 const f=vi.fn((url:string,init?:RequestInit)=>{
  const method=init?.method??'GET';
  if(method!=='GET')return Promise.resolve(write?write(url,method,JSON.parse(String(init!.body))):json({template:tpl(),results:[]}));
  if(url.startsWith('/api/recurring-invoices?'))return Promise.resolve(json({templates}));
  if(url.startsWith(`/api/recurring-invoices/${T1}`))return Promise.resolve(json({template:templates[0]}));
  if(url.startsWith('/api/invoices/customers'))return Promise.resolve(json({customers:[{id:CP,name:'Customer A',type:'customer'}],suppliers:[{id:CP,name:'Supplier A',type:'supplier'}]}));
  if(url.startsWith('/api/invoices/standard-rate'))return Promise.resolve(json({date:'2031-01-31',rate:'15.00'}));
  return Promise.resolve(json({}));});
 vi.stubGlobal('fetch',f);return f}
const posts=(f:ReturnType<typeof mock>)=>f.mock.calls.filter(c=>((c[1] as RequestInit|undefined)?.method??'GET')!=='GET');
beforeEach(async()=>{vi.restoreAllMocks();props.onChanged.mockReset();await i18n.changeLanguage('en')});

describe('RecurringInvoices',()=>{
 it('lists schedules with frequency, next date and status, and states that only drafts are created',async()=>{
  mock([tpl(),tpl({id:'x',name:'Old lease',status:'ended',next_run_date:'2032-01-01'})]);
  render(<RecurringInvoices {...props}/>);
  expect(await screen.findByText('Office rent')).toBeInTheDocument();
  expect(screen.getByText(/only creates draft invoices/)).toBeInTheDocument();
  expect(screen.getByText('Active')).toBeInTheDocument();expect(screen.getByText('Ended')).toBeInTheDocument();
  expect(screen.getAllByText('Monthly').length).toBeGreaterThan(0);
 });
 it('read-only users see schedules but no create, generate, edit, pause or end controls',async()=>{
  mock([tpl()]);
  render(<RecurringInvoices {...props} canManage={false} canGenerate={false}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Office rent'}));
  expect(await screen.findByText('Generated drafts')).toBeInTheDocument();
  for(const name of ['New recurring schedule +','Generate due drafts now','Edit','Pause','Resume','End schedule'])expect(screen.queryByRole('button',{name})).not.toBeInTheDocument();
 });
 it('generate-now needs the separate generate permission',async()=>{
  mock([tpl()]);
  render(<RecurringInvoices {...props} canGenerate={false}/>);
  await screen.findByText('Office rent');
  expect(screen.getByRole('button',{name:'New recurring schedule +'})).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Generate due drafts now'})).not.toBeInTheDocument();
 });
 it('creates a schedule sending raw inputs only (no amounts), then reloads',async()=>{
  const f=mock([],(url,method,body)=>{expect(method).toBe('POST');expect(url).toBe('/api/recurring-invoices');for(const k of ['vat_amount','total_amount','net_amount','next_run_date','status'])expect(body).not.toHaveProperty(k);return json({template:tpl()},201)});
  render(<RecurringInvoices {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'New recurring schedule +'}));
  fireEvent.change(screen.getByLabelText('Schedule name'),{target:{value:'Rent'}});
  fireEvent.change(await screen.findByLabelText('Customer'),{target:{value:CP}});
  fireEvent.change(screen.getByLabelText('Start date'),{target:{value:'2031-01-31'}});
  fireEvent.change(screen.getByLabelText('Days until due'),{target:{value:'30'}});
  fireEvent.change(screen.getByLabelText('Description'),{target:{value:'Service'}});
  fireEvent.change(screen.getByLabelText('Unit price'),{target:{value:'1000.00'}});
  fireEvent.change(screen.getByLabelText('VAT rate %'),{target:{value:'15'}});
  fireEvent.click(screen.getByRole('button',{name:'Save schedule'}));
  await waitFor(()=>expect(posts(f)).toHaveLength(1));
  const body=JSON.parse(String((posts(f)[0]![1] as RequestInit).body));
  expect(body).toEqual({direction:'sales',name:'Rent',counterparty_id:CP,frequency:'monthly',start_date:'2031-01-31',end_date:null,due_days:30,notes:null,lines:[{description:'Service',quantity:'1',unit_price:'1000.00',vat_rate:'15',vat_treatment:'standard'}]});
 });
 it('purchase schedules require an explicit input-VAT recovery choice per standard line and use suppliers',async()=>{
  mock([]);
  render(<RecurringInvoices {...props} direction="purchase"/>);
  fireEvent.click(await screen.findByRole('button',{name:'New recurring schedule +'}));
  expect(await screen.findByRole('option',{name:'Supplier A'})).toBeInTheDocument();
  expect(screen.getByLabelText('Input VAT recovery')).toBeRequired();
 });
 it('pause sends the version; a version conflict is explained and nothing else changes',async()=>{
  const f=mock([tpl()],()=>json({code:'RECURRING_VERSION_CONFLICT'},409));
  render(<RecurringInvoices {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Office rent'}));
  fireEvent.click(await screen.findByRole('button',{name:'Pause'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('changed by someone else');
  const call=posts(f)[0]!;expect(call[0]).toBe(`/api/recurring-invoices/${T1}/pause`);expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({version:3});
 });
 it('ending needs an explicit confirmation',async()=>{
  const f=mock([tpl()]);
  render(<RecurringInvoices {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Office rent'}));
  fireEvent.click(await screen.findByRole('button',{name:'End schedule'}));
  expect(posts(f)).toHaveLength(0);
  expect(screen.getByText(/cannot be resumed/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'End schedule'}));
  await waitFor(()=>expect(posts(f)).toHaveLength(1));
  expect(posts(f)[0]![0]).toBe(`/api/recurring-invoices/${T1}/end`);
 });
 it('after drafts exist, start date and frequency are locked in the edit form',async()=>{
  mock([tpl()]);
  render(<RecurringInvoices {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Office rent'}));
  fireEvent.click(await screen.findByRole('button',{name:'Edit'}));
  expect(await screen.findByLabelText('Start date')).toBeDisabled();
  expect(screen.getByLabelText('Frequency')).toBeDisabled();
 });
 it('shows the last generation problem on the schedule and in its details',async()=>{
  mock([tpl({last_error_code:'INVOICE_VAT_RATE_MISMATCH'})]);
  render(<RecurringInvoices {...props}/>);
  expect(await screen.findByText(/Last run needs attention/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Office rent'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('does not use the VAT rate');
 });
 it('generate-now reports the outcome and refreshes the invoice list only when drafts were created',async()=>{
  mock([tpl()],()=>json({results:[{template_id:T1,generated:[{occurrence_date:'2031-02-28',invoice_id:'n'}],skipped_existing:[],error_code:null}]}));
  render(<RecurringInvoices {...props}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Generate due drafts now'}));
  expect(await screen.findByRole('status')).toHaveTextContent('1 draft(s) created, 0 schedule(s) need attention.');
  expect(props.onChanged).toHaveBeenCalledTimes(1);
 });
 it('renders in Arabic',async()=>{
  await i18n.changeLanguage('ar');mock([]);
  render(<RecurringInvoices {...props}/>);
  expect(await screen.findByRole('button',{name:'جدولة متكررة جديدة +'})).toBeInTheDocument();
  expect(screen.getByText('الفواتير المتكررة')).toBeInTheDocument();
 });
});
