import {fireEvent,render,screen,waitFor,within} from './test-utils';
import {cleanup} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {InvoiceWorkspace} from '../components/SalesInvoices';
import i18n from '../i18n';

const ID='11111111-1111-4111-8111-111111111111',PARTY='22222222-2222-4222-8222-222222222222',DOC='55555555-5555-4555-8555-555555555555';
const base={id:ID,status:'draft',counterparty_id:PARTY,counterparty_name:'Gulf Supplies',internal_number:null,external_reference:'REF-9',issue_date:'2026-10-01',due_date:'2026-10-31',supply_date:null,tax_point_date:'2026-10-01',currency:'SAR',subtotal_amount:'100.00',vat_amount:'15.00',total_amount:'115.00',notes:null,version:2,created_by_user_id:'creator',source_document_id:null,
 lines:[{line_number:1,description:'Item',quantity:'1',unit_price:'100.00',discount_amount:'0.00',vat_rate:'15.00',net_amount:'100.00',vat_amount:'15.00',total_amount:'115.00',vat_treatment:'standard',vat_recoverability:'fully_recoverable'}],
 obligation:null,journal:null,vat:{status:'pending',review_id:null,tax_date:null},paid_amount:null,outstanding_amount:null,actionable_status:'draft'};
const caps={canView:true,canCreate:true,canEdit:true,canSubmit:true};
const full={...caps,canApprove:true,canPostJournal:true,canViewAccounting:true,canViewObligations:true,canViewVat:true,canViewDocuments:true,currentUserId:'approver'};
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
import {Vat} from '../components/Vat';
import en from '../i18n/locales/en';
import ar from '../i18n/locales/ar';

/** P1: stable codes become actionable AR/EN messages; the raw server text is never shown and navigation stays permission-gated. */
const RAW='raw-server-text-must-not-show';
const submitted={...base,status:'submitted',actionable_status:'awaiting_approval'};
beforeEach(async()=>{vi.restoreAllMocks();window.history.replaceState(null,'','/?page=purchases');document.body.style.overflow='';await i18n.changeLanguage('en')});

const VAT_CODES=['FORBIDDEN','VAT_RECOVERABILITY_INVALID','VAT_PERIOD_OUTSIDE_FISCAL_YEAR','VAT_PERIOD_OVERLAP','VAT_PERIOD_EXTERNAL','VAT_PROFILE_NOT_SINGLE','VAT_REGISTRATION_NOT_PERMITTED','VAT_PERIOD_BEFORE_REGISTRATION','VAT_PERIOD_OUTSIDE_REGISTRATION','VAT_FILING_FREQUENCY_REQUIRED','VAT_PERIOD_NOT_FULL_MONTH','VAT_PERIOD_NOT_FULL_QUARTER','VAT_DOCUMENT_NOT_ELIGIBLE','VAT_PERIOD_CLOSED','VAT_REVIEW_VERSION_CONFLICT','VAT_PERIOD_NOT_OPEN','VAT_PERIOD_HAS_BLOCKERS','VAT_PERIOD_NOT_CLOSED'];
const REASONS={INVOICE_VAT_INCOMPLETE:['tax_point_missing','line_treatment_missing','recoverability_missing','sales_recoverability_present'],INVOICE_FISCAL_YEAR_UNRESOLVED:['no_fiscal_year','multiple_fiscal_years']};

describe('P1 error localization',()=>{
 it('has distinct Arabic and English text for every new code and reason',()=>{
  for(const code of VAT_CODES){const e=(en as any).errors[code],a=(ar as any).errors[code];expect(e,code).toBeTruthy();expect(a,code).toBeTruthy();expect(a).not.toBe(e);expect(a).toMatch(/[؀-ۿ]/)}
  for(const [code,reasons] of Object.entries(REASONS))for(const r of reasons){const e=(en as any).salesInvoice.errorReasons[code][r],a=(ar as any).salesInvoice.errorReasons[code][r];expect(e,`${code}.${r}`).toBeTruthy();expect(a).toMatch(/[؀-ۿ]/)}
  expect((en as any).vat.actionError).toBeTruthy();expect((ar as any).vat.actionError).toMatch(/[؀-ۿ]/);
 });
 it('keeps VAT_INCOMPLETE guidance valid for both submit and approval',()=>{
  for(const l of [en,ar] as any[])for(const text of Object.values(l.salesInvoice.errorReasons.INVOICE_VAT_INCOMPLETE) as string[]){expect(text).not.toMatch(/return a submitted invoice to draft first|أعد الفاتورة المرسلة إلى مسودة أولًا/);expect(text).toMatch(/If the invoice is already submitted|إذا كانت الفاتورة مرسلة/)}
 });
 it('drops the obsolete self-approval and unused approval texts',()=>{
  for(const l of [en,ar] as any[]){expect(l.salesInvoice.errors.INVOICE_SELF_APPROVAL).toBeUndefined();expect(l.invoiceNotes.errors.INVOICE_SELF_APPROVAL).toBeUndefined();expect(l.salesInvoice.errors.INVOICE_VAT_PREREQUISITE).toBeUndefined();expect(l.salesInvoice.errors.INVOICE_DIRECTION_UNSUPPORTED).toBeUndefined()}
 });
});

describe('Invoice workspace actionable errors',()=>{
 const fail=(action:'submit'|'approve',body:Record<string,unknown>,status:number,invoice:Record<string,unknown>)=>mockApi(invoice,(key)=>key===`POST /api/invoices/${ID}/${action}`?json({error:RAW,...body},status):undefined);
 const run=async(label:string,props:Record<string,unknown>=full)=>{render(<InvoiceWorkspace {...(props as typeof full)} onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByText('REF-9'));fireEvent.click(await screen.findByRole('button',{name:label}));return screen.findByRole('alert')};
 it('names the missing purchase VAT recovery on submit',async()=>{fail('submit',{code:'INVOICE_VAT_INCOMPLETE',reason:'recoverability_missing'},409,base);const alert=await run('Submit');expect(alert).toHaveTextContent(en.salesInvoice.errorReasons.INVOICE_VAT_INCOMPLETE.recoverability_missing);expect(alert).not.toHaveTextContent(RAW)});
 it('names the missing tax point on approval in Arabic',async()=>{await i18n.changeLanguage('ar');fail('approve',{code:'INVOICE_VAT_INCOMPLETE',reason:'tax_point_missing'},409,submitted);render(<InvoiceWorkspace {...full} onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByText('REF-9'));fireEvent.click(await screen.findByRole('button',{name:ar.invoiceWorkspace.approve}));const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent(ar.salesInvoice.errorReasons.INVOICE_VAT_INCOMPLETE.tax_point_missing);expect(alert).not.toHaveTextContent(RAW)});
 it('distinguishes overlapping fiscal years',async()=>{fail('approve',{code:'INVOICE_FISCAL_YEAR_UNRESOLVED',reason:'multiple_fiscal_years'},409,submitted);expect(await run('Approve invoice')).toHaveTextContent(en.salesInvoice.errorReasons.INVOICE_FISCAL_YEAR_UNRESOLVED.multiple_fiscal_years)});
 it('falls back to the code text for an unknown reason and to generic for an unknown code',async()=>{fail('approve',{code:'INVOICE_FISCAL_YEAR_UNRESOLVED',reason:'something_new'},409,submitted);expect(await run('Approve invoice')).toHaveTextContent(en.salesInvoice.errors.INVOICE_FISCAL_YEAR_UNRESOLVED);cleanup();fail('approve',{code:'NOT_A_REAL_CODE'},409,submitted);const alert=await run('Approve invoice');expect(alert).toHaveTextContent(en.salesInvoice.errors.generic);expect(alert).not.toHaveTextContent(RAW)});
 it('explains a missing capability instead of a data error',async()=>{fail('approve',{code:'FORBIDDEN'},403,submitted);const alert=await run('Approve invoice');expect(alert).toHaveTextContent(en.errors.FORBIDDEN);expect(alert).not.toHaveTextContent(en.salesInvoice.errors.generic)});
 it('guides an approver without mapping access to ask an authorized user and offers no link',async()=>{fail('approve',{code:'INVOICE_MAPPING_MISSING',missing_keys:['vat_input']},409,submitted);await run('Approve invoice');const hint=await screen.findByTestId('mapping-missing');expect(hint).toHaveTextContent(en.invoiceMappings.askAdmin);expect(screen.queryByRole('button',{name:en.invoiceMappings.goToPage})).toBeNull()});
});

describe('VAT workspace actionable errors',()=>{
 const period={id:'vat-1',fiscal_year_id:'fy',period_start:'2026-01-01',period_end:'2026-03-31',status:'open',ready:true,blockers:{unapproved_documents:0,missing_reviews:0,pending_reviews:0,vat_recoverability_pending:0,vat_ledger_mismatches:0,vat_adjustments_pending:0,total:0}};
 const stub=(write:(url:string)=>Response)=>vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method&&init.method!=='GET')return write(url);if(url==='/api/vat-periods')return json({periods:[period]});if(url==='/api/fiscal-years')return json({fiscalYears:[{id:'fy',name:'FY 2026',start_date:'2026-01-01',end_date:'2026-12-31'}]});return json({period,documents:[]})}));
 const createPeriod=async()=>{render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByRole('button',{name:i18n.t('vat.createPeriod')}));const dialog=await screen.findByRole('dialog');const form=dialog.querySelector('form')!;fireEvent.change(form.querySelector('[name=period_start]')!,{target:{value:'2026-01-01'}});fireEvent.change(form.querySelector('[name=period_end]')!,{target:{value:'2026-03-31'}});fireEvent.submit(form);return dialog};
 it('explains a VAT registration problem inside the create dialog in English',async()=>{stub(()=>json({error:RAW,code:'VAT_REGISTRATION_NOT_PERMITTED'},409));const dialog=await createPeriod();expect(await within(dialog).findByRole('alert')).toHaveTextContent(en.errors.VAT_REGISTRATION_NOT_PERMITTED);expect(dialog).not.toHaveTextContent(RAW)});
 it('explains a frequency mismatch in Arabic',async()=>{await i18n.changeLanguage('ar');stub(()=>json({error:RAW,code:'VAT_PERIOD_NOT_FULL_QUARTER'},409));const dialog=await createPeriod();expect(await within(dialog).findByRole('alert')).toHaveTextContent(ar.errors.VAT_PERIOD_NOT_FULL_QUARTER)});
 it('explains a missing capability and an uncoded failure without raw text',async()=>{stub(()=>json({error:'Forbidden',code:'FORBIDDEN'},403));let dialog=await createPeriod();expect(await within(dialog).findByRole('alert')).toHaveTextContent(en.errors.FORBIDDEN);cleanup();stub(()=>json({error:RAW},400));dialog=await createPeriod();const alert=await within(dialog).findByRole('alert');expect(alert).toHaveTextContent(en.vat.actionError);expect(alert).not.toHaveTextContent(RAW)});
 it('shows why closing failed on the page',async()=>{stub(()=>json({error:RAW,code:'VAT_PERIOD_HAS_BLOCKERS'},409));render(<Vat canView canReview canClose canReopen onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByRole('button',{name:en.vat.closePeriod}));await waitFor(()=>expect(screen.getAllByRole('alert').some(a=>a.textContent===en.errors.VAT_PERIOD_HAS_BLOCKERS)).toBe(true));expect(document.body).not.toHaveTextContent(RAW)});
});
