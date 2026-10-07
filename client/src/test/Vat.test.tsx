import {fireEvent,screen,waitFor,within} from './test-utils';
import {render} from './test-utils';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import '../i18n';
import i18n from '../i18n';
import {Vat} from '../components/Vat';

const period={id:'vat-1',fiscal_year_id:'fy',period_start:'2026-01-01',period_end:'2026-03-31',status:'open',ready:true,blockers:{unapproved_documents:0,missing_reviews:0,pending_reviews:0,vat_recoverability_pending:0,vat_ledger_mismatches:0,vat_adjustments_pending:0,total:0}};
const documents=[
 {id:'d1',status:'approved',original_filename:'sale-acme.pdf',document_type:'sale',document_date:'2026-01-10',counterparty_name:'Acme',total_amount:'115.00',review_id:'r1',tax_date:'2026-01-10',treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00',review_status:'reviewed',review_note:'Invoice REF-1',version:1},
 {id:'d2',status:'approved',original_filename:'expense-beta.pdf',document_type:'expense',document_date:'2026-01-11',counterparty_name:'Beta',total_amount:'57.50',review_id:null,tax_date:null,treatment:null,taxable_amount:null,vat_amount:null,review_status:null,review_note:null,version:null},
] as any[];
function mock(){vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[period]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[{id:'fy',name:'FY 2026',start_date:'2026-01-01',end_date:'2026-12-31'}]}),{status:200});return new Response(JSON.stringify({period,documents}),{status:200})}))}
beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks()});
describe('VAT review workspace',()=>{
 it('filters displayed documents locally by search and treatment',async()=>{mock();render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);expect(await screen.findByRole('cell',{name:'sale-acme.pdf'})).toBeInTheDocument();fireEvent.change(screen.getByRole('searchbox',{name:'Search documents'}),{target:{value:'Beta'}});expect(screen.queryByRole('cell',{name:'sale-acme.pdf'})).not.toBeInTheDocument();expect(screen.getByRole('cell',{name:'expense-beta.pdf'})).toBeInTheDocument();fireEvent.change(screen.getByLabelText('VAT treatment'),{target:{value:'standard'}});expect(screen.getByText('No documents match the current search and filters.')).toBeInTheDocument()});
 it('keeps period and review actions capability and status gated',async()=>{mock();render(<Vat canView canReview={false} canClose={false} canReopen={false} onUnauthorized={vi.fn()}/>);await screen.findByRole('cell',{name:'sale-acme.pdf'});expect(screen.queryByRole('button',{name:'Create VAT period'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:/Review VAT|Edit VAT review/})).not.toBeInTheDocument();expect(within(screen.getByRole('table')).getAllByText('—').length).toBeGreaterThan(0)});
 it('refreshes the open detail pane after saving a VAT review',async()=>{let saved=false;const updated={...documents[0],tax_date:'2026-02-20',treatment:'zero_rated',taxable_amount:'220.00',vat_amount:'0.00',review_note:'Updated REF-2',version:2};const fetchMock=vi.fn(async(url:string,options?:RequestInit)=>{if(url==='/api/documents/d1/vat-review'&&options?.method==='PUT'){saved=true;return new Response('{}',{status:200})}if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[period]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[{id:'fy',name:'FY 2026',start_date:'2026-01-01',end_date:'2026-12-31'}]}),{status:200});return new Response(JSON.stringify({period,documents:saved?[updated,documents[1]]:documents}),{status:200})});vi.stubGlobal('fetch',fetchMock);render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByRole('cell',{name:'sale-acme.pdf'}));expect(screen.getByText('Invoice REF-1')).toBeInTheDocument();fireEvent.click(within(screen.getByRole('complementary',{name:'VAT document details'})).getByRole('button',{name:'Edit VAT review'}));const reviewDialog=screen.getByRole('dialog',{name:'Review VAT'});fireEvent.change(within(reviewDialog).getByLabelText('Tax date'),{target:{value:'2026-02-20'}});fireEvent.change(within(reviewDialog).getByLabelText('VAT treatment'),{target:{value:'zero_rated'}});fireEvent.change(within(reviewDialog).getByLabelText('Taxable amount'),{target:{value:'220.00'}});fireEvent.change(within(reviewDialog).getByLabelText('VAT amount'),{target:{value:'0.00'}});fireEvent.change(within(reviewDialog).getByLabelText('Review note'),{target:{value:'Updated REF-2'}});fireEvent.click(within(reviewDialog).getByRole('button',{name:'Save'}));await waitFor(()=>{const detail=screen.getByRole('complementary',{name:'VAT document details'});expect(within(detail).getByText('Updated REF-2')).toBeInTheDocument();expect(within(detail).getByText('Zero-rated')).toBeInTheDocument();expect(within(detail).getByText('220.00')).toBeInTheDocument();expect(within(detail).getByText('0.00')).toBeInTheDocument();expect(within(detail).queryByText('Invoice REF-1')).not.toBeInTheDocument()})});
 it('shows blocker categories, a disabled close action and an LTR-isolated period range',async()=>{const blocked={...period,ready:false,blockers:{unapproved_documents:1,missing_reviews:0,pending_reviews:0,vat_recoverability_pending:0,vat_ledger_mismatches:0,vat_adjustments_pending:0,total:1}};vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[blocked]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[]}),{status:200});return new Response(JSON.stringify({period:blocked,documents}),{status:200})}));const {container}=render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);await screen.findByRole('cell',{name:'sale-acme.pdf'});expect(screen.getByRole('button',{name:'Close VAT period'})).toBeDisabled();expect(screen.getByText('Not ready to close')).toBeInTheDocument();expect(screen.getAllByText('No blockers')).toHaveLength(5);const range=container.querySelector('.vat-range');expect(range).toHaveAttribute('dir','ltr');expect(range?.querySelectorAll('bdi[dir="rtl"]')).toHaveLength(2)});
 it('surfaces every backend blocker category, including recoverability, ledger mismatch and pending adjustments',async()=>{const blocked={...period,ready:false,blockers:{unapproved_documents:0,missing_reviews:0,pending_reviews:0,vat_recoverability_pending:2,vat_ledger_mismatches:1,vat_adjustments_pending:3,total:6}};vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[blocked]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[]}),{status:200});return new Response(JSON.stringify({period:blocked,documents}),{status:200})}));render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);await screen.findByRole('cell',{name:'sale-acme.pdf'});expect(screen.getByText('6 blocking items')).toBeInTheDocument();for(const [label,count] of [['Pending VAT recoverability decisions','2'],['VAT ledger mismatches','1'],['Pending VAT adjustments','3']]){const row=screen.getByText(label).closest('li') as HTMLElement;expect(within(row).getByText(count)).toBeInTheDocument();expect(within(row).getByText('Blocking')).toBeInTheDocument()}expect(screen.getAllByText('No blockers')).toHaveLength(3);expect(screen.getByRole('button',{name:'Close VAT period'})).toBeDisabled()});
 it('uses Arabic plural forms for the blocker count',async()=>{await i18n.changeLanguage('ar');const forms:Record<number,string>={0:'0 عناصر مانعة',1:'1 عنصر مانع',2:'2 عنصران مانعان',5:'5 عناصر مانعة',11:'11 عنصرًا مانعًا',100:'100 عنصر مانع'};for(const [count,text] of Object.entries(forms))expect(i18n.t('vat.blocked',{count:Number(count)})).toBe(text)});

 it('drills actionable blockers to the relevant screen and keeps others informational',async()=>{
  const blocked={...period,ready:false,blockers:{unapproved_documents:2,missing_reviews:1,pending_reviews:0,vat_recoverability_pending:1,vat_ledger_mismatches:3,vat_adjustments_pending:1,total:8}};
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[blocked]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[]}),{status:200});return new Response(JSON.stringify({period:blocked,documents}),{status:200})}));
  const onNavigate=vi.fn();
  render(<Vat canView canReview canClose canReopen canViewDocuments canViewAccounting onNavigate={onNavigate} onUnauthorized={vi.fn()}/>);
  const unapproved=await screen.findByRole('button',{name:'Unapproved documents'});
  fireEvent.click(unapproved);
  expect(onNavigate).toHaveBeenCalledWith('documents',{from:'2026-01-01',to:'2026-03-31'});
  fireEvent.click(screen.getByRole('button',{name:'VAT ledger mismatches'}));
  expect(onNavigate).toHaveBeenCalledWith('accounting',{accountingTab:'sources',sourceFrom:'2026-01-01',sourceTo:'2026-03-31'});
  // no safe destination: informational text, not a button
  expect(screen.getByRole('button',{name:'Pending VAT recoverability decisions'})).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Pending VAT adjustments'})).not.toBeInTheDocument();
  // zero-count blocker is never a button
  expect(screen.queryByRole('button',{name:'Pending VAT reviews'})).not.toBeInTheDocument();
  // in-page blocker filters the register to documents that still need a review
  fireEvent.click(screen.getByRole('button',{name:'Missing VAT reviews'}));
  expect(onNavigate).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('combobox',{name:'Review status'})).toHaveValue('not_reviewed');
  expect(screen.queryByRole('cell',{name:'sale-acme.pdf'})).not.toBeInTheDocument();
  expect(screen.getByRole('cell',{name:'expense-beta.pdf'})).toBeInTheDocument();
 });
 it('hides navigation-only blockers without the destination capability',async()=>{
  const blocked={...period,ready:false,blockers:{unapproved_documents:2,missing_reviews:0,pending_reviews:0,vat_recoverability_pending:0,vat_ledger_mismatches:3,vat_adjustments_pending:0,total:5}};
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[blocked]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[]}),{status:200});return new Response(JSON.stringify({period:blocked,documents}),{status:200})}));
  render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);
  expect(await screen.findByText('Unapproved documents')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Unapproved documents'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'VAT ledger mismatches'})).not.toBeInTheDocument();
 });
 it('makes actionable blockers keyboard reachable and supports Arabic labels',async()=>{
  await i18n.changeLanguage('ar');
  const blocked={...period,ready:false,blockers:{unapproved_documents:2,missing_reviews:0,pending_reviews:0,vat_recoverability_pending:0,vat_ledger_mismatches:0,vat_adjustments_pending:0,total:2}};
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[blocked]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[]}),{status:200});return new Response(JSON.stringify({period:blocked,documents}),{status:200})}));
  const onNavigate=vi.fn();
  render(<Vat canView canReview canClose canReopen canViewDocuments onNavigate={onNavigate} onUnauthorized={vi.fn()}/>);
  const button=await screen.findByRole('button',{name:'مستندات غير معتمدة'});
  expect(button.tagName).toBe('BUTTON');
  expect(button).toHaveAttribute('type','button');
  expect(button).toHaveClass('vat-blocker-link');
  button.focus();expect(button).toHaveFocus();
  fireEvent.click(button);
  expect(onNavigate).toHaveBeenCalledWith('documents',{from:'2026-01-01',to:'2026-03-31'});
 });

 it('resolves a pending recoverability blocker through the existing VAT review dialog',async()=>{
  const blocked={...period,ready:false,blockers:{unapproved_documents:0,missing_reviews:0,pending_reviews:0,vat_recoverability_pending:1,vat_ledger_mismatches:0,vat_adjustments_pending:1,total:2}};
  const expense={id:'d3',status:'approved',original_filename:'expense-gamma.pdf',document_type:'expense',document_date:'2026-01-12',counterparty_name:'Gamma',total_amount:'115.00',review_id:'r3',tax_date:'2026-01-12',treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00',review_status:'reviewed',review_note:null,version:2,recoverability_status:'needs_review',recoverable_vat_amount:null,recoverability_reason:null};
  const calls:{url:string;body:any}[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{if(options?.method==='PUT'){calls.push({url,body:JSON.parse(String(options.body))});return new Response('{}',{status:200})}if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[blocked]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[]}),{status:200});return new Response(JSON.stringify({period:blocked,documents:[...documents,expense]}),{status:200})}));
  render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Pending VAT recoverability decisions'}));
  expect(screen.getByRole('combobox',{name:'Review status'})).toHaveValue('recoverability');
  expect(screen.getByRole('cell',{name:'expense-gamma.pdf'})).toBeInTheDocument();
  expect(screen.queryByRole('cell',{name:'sale-acme.pdf'})).not.toBeInTheDocument();
  // exactly one match: its detail pane opens automatically, nothing is submitted or edited yet
  const detail=await screen.findByLabelText('VAT document details');
  expect(within(detail).getByText('expense-gamma.pdf')).toBeInTheDocument();
  expect(calls).toHaveLength(0);
  expect(screen.queryByLabelText('VAT recoverability')).not.toBeInTheDocument();
  fireEvent.click(within(detail).getByRole('button',{name:/Edit VAT review/}));
  fireEvent.change(screen.getByLabelText('VAT recoverability'),{target:{value:'partially_recoverable'}});
  fireEvent.change(screen.getByLabelText('Recoverable VAT amount'),{target:{value:'5.00'}});
  fireEvent.change(screen.getByLabelText('Recoverability reason'),{target:{value:'Mixed use'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(calls).toHaveLength(1));
  expect(calls[0].url).toBe('/api/documents/d3/vat-review');
  expect(calls[0].body).toMatchObject({review_status:'reviewed',vat_amount:'15.00',recoverability_status:'partially_recoverable',recoverable_vat_amount:'5.00',recoverability_reason:'Mixed use',version:2});
 });
 it('derives the recoverable amount for full and non-recoverable decisions and omits it for sales',async()=>{
  const expense={id:'d3',status:'approved',original_filename:'expense-gamma.pdf',document_type:'expense',document_date:'2026-01-12',counterparty_name:'Gamma',total_amount:'115.00',review_id:'r3',tax_date:'2026-01-12',treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00',review_status:'reviewed',review_note:null,version:2,recoverability_status:'needs_review'};
  const calls:any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{if(options?.method==='PUT'){calls.push(JSON.parse(String(options.body)));return new Response('{}',{status:200})}if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[period]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[]}),{status:200});return new Response(JSON.stringify({period,documents:[...documents,expense]}),{status:200})}));
  render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('cell',{name:'expense-gamma.pdf'}));
  fireEvent.click(within(await screen.findByLabelText('VAT document details')).getByRole('button',{name:/Edit VAT review/}));
  fireEvent.change(screen.getByLabelText('VAT recoverability'),{target:{value:'fully_recoverable'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({recoverability_status:'fully_recoverable',recoverable_vat_amount:'15.00'});
  fireEvent.click(await screen.findByRole('cell',{name:'sale-acme.pdf'}));
  fireEvent.click(within(await screen.findByLabelText('VAT document details')).getByRole('button',{name:/Edit VAT review/}));
  expect(screen.queryByLabelText('VAT recoverability')).not.toBeInTheDocument();
 });
 it('labels the recoverability workflow in Arabic',async()=>{
  await i18n.changeLanguage('ar');
  const expense={id:'d3',status:'approved',original_filename:'expense-gamma.pdf',document_type:'expense',document_date:'2026-01-12',counterparty_name:'Gamma',total_amount:'115.00',review_id:'r3',tax_date:'2026-01-12',treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00',review_status:'reviewed',review_note:null,version:2,recoverability_status:'needs_review'};
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[period]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[]}),{status:200});return new Response(JSON.stringify({period,documents:[expense]}),{status:200})}));
  render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('cell',{name:'expense-gamma.pdf'}));
  fireEvent.click(within(await screen.findByLabelText('تفاصيل المستند الضريبي')).getByRole('button',{name:'تعديل المراجعة'}));
  expect(screen.getByLabelText('استرداد الضريبة')).toBeInTheDocument();
 });

 const pendingExpense=(id:string,name:string)=>({id,status:'approved',original_filename:name,document_type:'expense',document_date:'2026-01-12',counterparty_name:'Gamma',total_amount:'115.00',review_id:'r-'+id,tax_date:'2026-01-12',treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00',review_status:'reviewed',review_note:null,version:2,recoverability_status:'needs_review'});
 const recoverabilityMock=(docs:any[])=>{const blocked={...period,ready:false,blockers:{unapproved_documents:0,missing_reviews:0,pending_reviews:0,vat_recoverability_pending:docs.length,vat_ledger_mismatches:0,vat_adjustments_pending:0,total:docs.length}};vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[blocked]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[]}),{status:200});return new Response(JSON.stringify({period:blocked,documents:docs}),{status:200})}))};
 it('does not auto-select a document when several are pending recoverability',async()=>{
  recoverabilityMock([pendingExpense('x1','exp-1.pdf'),pendingExpense('x2','exp-2.pdf')]);
  render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Pending VAT recoverability decisions'}));
  expect(screen.getByRole('cell',{name:'exp-1.pdf'})).toBeInTheDocument();
  expect(screen.getByRole('cell',{name:'exp-2.pdf'})).toBeInTheDocument();
  expect(screen.queryByLabelText('VAT document details')).not.toBeInTheDocument();
 });
 it('opens the single pending document without offering edit when the user lacks vat.review',async()=>{
  recoverabilityMock([pendingExpense('x1','exp-1.pdf')]);
  render(<Vat canView canReview={false} canClose={false} canReopen={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Pending VAT recoverability decisions'}));
  const detail=await screen.findByLabelText('VAT document details');
  expect(within(detail).queryByRole('button',{name:/VAT review/})).not.toBeInTheDocument();
 });
});

describe('VAT summary drill-down',()=>{
 const docs=[...documents,{id:'d3',status:'approved',original_filename:'purchase-gamma.pdf',document_type:'purchase',document_date:'2026-02-01',counterparty_name:'Gamma',total_amount:'23.00',review_id:'r3',tax_date:'2026-02-01',treatment:'standard',taxable_amount:'20.00',vat_amount:'3.00',review_status:'reviewed',review_note:null,version:1,recoverability_status:'fully_recoverable',recoverable_vat_amount:'3.00'}] as any[];
 const stub=(list:any[])=>vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url==='/api/vat-periods')return new Response(JSON.stringify({periods:[period]}),{status:200});if(url==='/api/fiscal-years')return new Response(JSON.stringify({fiscalYears:[]}),{status:200});return new Response(JSON.stringify({period,documents:list}),{status:200})}));
 it('filters the register to the reviewed documents behind each figure and resets',async()=>{
  stub(docs);render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);
  await screen.findByRole('cell',{name:'sale-acme.pdf'});
  fireEvent.click(screen.getByRole('button',{name:/Output VAT/}));
  expect(screen.getByRole('cell',{name:'sale-acme.pdf'})).toBeInTheDocument();
  expect(screen.queryByRole('cell',{name:'purchase-gamma.pdf'})).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Output VAT');
  fireEvent.click(screen.getByRole('button',{name:/Input VAT/}));
  expect(screen.getByRole('cell',{name:'purchase-gamma.pdf'})).toBeInTheDocument();
  expect(screen.queryByRole('cell',{name:'sale-acme.pdf'})).not.toBeInTheDocument();
  // unreviewed documents never contribute to a figure
  expect(screen.queryByRole('cell',{name:'expense-beta.pdf'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:/Net VAT/}));
  expect(screen.getByRole('cell',{name:'sale-acme.pdf'})).toBeInTheDocument();
  expect(screen.getByRole('cell',{name:'purchase-gamma.pdf'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));
  expect(screen.getByRole('cell',{name:'expense-beta.pdf'})).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
 });
 it('renders plain figures, not dead buttons, when the period has no documents',async()=>{
  stub([]);render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);
  await screen.findByText('No VAT-relevant documents in this period.');
  expect(screen.queryByRole('button',{name:/Output VAT/})).not.toBeInTheDocument();
 });
});
