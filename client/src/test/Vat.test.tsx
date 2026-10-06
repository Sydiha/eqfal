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
  expect(screen.queryByRole('button',{name:'Pending VAT recoverability decisions'})).not.toBeInTheDocument();
  expect(screen.getByText('Pending VAT recoverability decisions')).toBeInTheDocument();
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
  render(<Vat canView canReview canClose canReopen canViewDocuments onNavigate={vi.fn()} onUnauthorized={vi.fn()}/>);
  const button=await screen.findByRole('button',{name:'مستندات غير معتمدة'});
  expect(button.tagName).toBe('BUTTON');
  expect(button).toHaveAttribute('type','button');
 });
});
