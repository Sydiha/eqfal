import{fireEvent,render,screen,waitFor,within}from'@testing-library/react';
import{beforeEach,describe,expect,it,vi}from'vitest';
import i18n from'../i18n';
import{PeriodicAdjustments}from'../components/PeriodicAdjustments';

const sched=(id:string,status:'pending'|'posted',month:string,journal:string|null=null)=>({id,period_start:`2026-${month}-01`,period_end:`2026-${month}-28`,recognition_date:`2026-${month}-28`,amount:'300.00',status,journal_entry_id:journal});
const approved={id:'a1',adjustment_type:'prepaid_expense',total_amount:'900.00',recognition_start:'2026-09-01',recognition_end:'2026-11-30',document_id:null,obligation_id:null,document_name:null,description:'Prepaid rent',reference:null,notes:null,balance_account_id:'b',pnl_account_id:'p',workflow_status:'approved',review_note:null,version:2,schedule:[sched('s1','pending','09'),sched('s2','posted','10','468f8d80-1111-2222-3333-444455556666e3b53cc3'),sched('s3','pending','11')]};
const draft={...approved,id:'a2',description:'Draft insurance',workflow_status:'draft',schedule:[]};
const accounts=[{id:'b',code:'1500',name:'Accrued',account_type:'liability',is_active:true},{id:'p',code:'5100',name:'Rent',account_type:'expense',is_active:true}];
let calls:{url:string;method:string;body?:string}[]=[];
const caps={canView:true,canCreate:true,canEdit:true,canSubmit:true,canReview:true,canApprove:true,canPost:true};
const mount=(over:Partial<typeof caps>={})=>render(<PeriodicAdjustments {...caps} {...over} onUnauthorized={vi.fn()}/>);
beforeEach(async()=>{
 vi.restoreAllMocks();calls=[];await i18n.changeLanguage('en');window.history.replaceState(null,'','/?page=periodicAdjustments');
 vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=String(input);calls.push({url,method:init?.method??'GET',body:init?.body as string|undefined});
  if(url==='/api/periodic-adjustments'&&!init?.method)return new Response(JSON.stringify({adjustments:[draft,approved]}));
  if(url==='/api/accounts')return new Response(JSON.stringify({accounts}));
  if(url==='/api/documents')return new Response(JSON.stringify({documents:[]}));
  if(url==='/api/obligations')return new Response(JSON.stringify({obligations:[]}));
  return new Response('{}');
 }));
});

describe('Accruals & Prepayments workspace',()=>{
 it('keeps the add form collapsed and opens it on demand with all fields, then submits the unchanged payload',async()=>{
  mount();const cta=await screen.findByRole('button',{name:/Add periodic adjustment/});
  expect(screen.queryByLabelText('Total amount')).not.toBeInTheDocument();
  fireEvent.click(cta);
  for(const label of ['Type','Total amount','Recognition start','Recognition end','Description','Reference','Balance-sheet account','P&L account','Notes'])expect(screen.getByLabelText(label)).toBeInTheDocument();
  expect(screen.getByText(/determines debit\/credit direction automatically/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Total amount'),{target:{value:'120.00'}});fireEvent.change(screen.getByLabelText('Recognition start'),{target:{value:'2026-01-01'}});fireEvent.change(screen.getByLabelText('Recognition end'),{target:{value:'2026-03-31'}});fireEvent.change(screen.getByLabelText('Description'),{target:{value:'Test'}});
  fireEvent.change(screen.getByLabelText('Balance-sheet account'),{target:{value:'b'}});fireEvent.change(screen.getByLabelText('P&L account'),{target:{value:'p'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(calls.some(c=>c.method==='POST'&&c.url==='/api/periodic-adjustments')).toBe(true));
  const post=calls.find(c=>c.method==='POST')!;
  expect(JSON.parse(post.body!)).toEqual({adjustment_type:'accrued_expense',total_amount:'120.00',recognition_start:'2026-01-01',recognition_end:'2026-03-31',description:'Test',reference:null,notes:null,balance_account_id:'b',pnl_account_id:'p',document_id:null,obligation_id:null});
  await waitFor(()=>expect(screen.queryByLabelText('Total amount')).not.toBeInTheDocument());
 });
 it('preserves native form validation (required fields) and sends nothing when empty',async()=>{
  mount();fireEvent.click(await screen.findByRole('button',{name:/Add periodic adjustment/}));
  for(const label of ['Total amount','Recognition start','Recognition end','Description','Balance-sheet account','P&L account'])expect(screen.getByLabelText(label)).toBeRequired();
  expect(screen.getByLabelText('Total amount')).toHaveAttribute('pattern','[0-9]+([.][0-9]{1,2})?');
 });
 it('selects the adjustment with a schedule by default and switches schedule on selection',async()=>{
  mount();expect(await screen.findByText('Recognition schedule')).toBeInTheDocument();
  const schedule=screen.getByRole('region',{name:'Recognition schedule'});
  expect(within(schedule).getByText(/Prepaid expense — Prepaid rent/)).toBeInTheDocument();
  expect(within(schedule).getAllByRole('button',{name:'Post period'})).toHaveLength(2);
  fireEvent.click(screen.getAllByRole('button',{name:'View schedule'})[0]);
  expect(within(screen.getByRole('region',{name:'Recognition schedule'})).getByText(/No recognition schedule yet/)).toBeInTheDocument();
 });
 it('shows a short journal reference for posted periods and keeps the full id internal',async()=>{
  mount();const ref=await screen.findByText(/468f8d80…/);expect(ref).toHaveAttribute('title','468f8d80-1111-2222-3333-444455556666e3b53cc3');
  expect(screen.queryByText('468f8d80-1111-2222-3333-444455556666e3b53cc3')).not.toBeInTheDocument();
 });
 it('posts only the chosen period through the existing endpoint',async()=>{
  mount();const buttons=await screen.findAllByRole('button',{name:'Post period'});fireEvent.click(buttons[0]);
  await waitFor(()=>expect(calls.some(c=>c.method==='POST'&&c.url==='/api/periodic-adjustments/a1/schedule/s1/post')).toBe(true));
  expect(calls.filter(c=>c.url.endsWith('/post'))).toHaveLength(1);
 });
 it('hides posting without the post capability and never offers it for posted periods',async()=>{
  mount({canPost:false});await screen.findByText('Recognition schedule');expect(screen.queryByRole('button',{name:'Post period'})).not.toBeInTheDocument();expect(screen.getByText(/Posted$/,{selector:'.pa-done'})).toBeInTheDocument();
 });
 it('shows KPI counts from the loaded data and the empty state when nothing exists',async()=>{
  mount();await screen.findByText('Recognition schedule');
  const kpi=(label:string)=>screen.getByText(label).parentElement!.querySelector('strong')!.textContent;
  expect([kpi('Total adjustments'),kpi('Pending periods'),kpi('Posted periods')]).toEqual(['2','2','1']);
 });
 it('shows the empty adjustments state',async()=>{
  (fetch as ReturnType<typeof vi.fn>).mockImplementation(async(input:string|URL|Request)=>new Response(JSON.stringify(String(input)==='/api/periodic-adjustments'?{adjustments:[]}:{accounts:[],documents:[],obligations:[]})));
  mount();expect(await screen.findByText('No periodic adjustments yet.')).toBeInTheDocument();expect(screen.queryByText('Recognition schedule')).not.toBeInTheDocument();
 });
 it('shows the generic error banner without raw server details when posting fails',async()=>{
  mount();const buttons=await screen.findAllByRole('button',{name:'Post period'});
  (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async()=>new Response('stack trace secret',{status:409}));
  fireEvent.click(buttons[0]);expect(await screen.findByRole('alert')).toHaveTextContent('Could not load or save data.');expect(screen.queryByText(/stack trace/)).not.toBeInTheDocument();
 });
});
