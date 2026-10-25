import {fireEvent,render,screen,waitFor,within} from './test-utils';
import {cleanup} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {InvoiceWorkspace} from '../components/SalesInvoices';
import i18n from '../i18n';

/** P2-B: layout of the invoice details dialog (summary header, collapsible sections, "More" menu, footer errors). */
const ID='11111111-1111-4111-8111-111111111111';
const line={line_number:1,description:'Consulting',quantity:'2',unit_price:'100.00',discount_amount:'20.00',vat_rate:'15.00',net_amount:'180.00',vat_amount:'27.00',total_amount:'207.00',vat_treatment:'standard'};
const base={id:ID,status:'draft',counterparty_id:'p',counterparty_name:'Gulf Supplies',internal_number:null,external_reference:'REF-9',issue_date:'2026-10-01',due_date:'2026-10-31',supply_date:null,tax_point_date:'2026-10-01',currency:'SAR',subtotal_amount:'180.00',vat_amount:'27.00',total_amount:'207.00',notes:null,version:2,lines:[line],obligation:null,journal:null,vat:{status:'pending',review_id:null,tax_date:null},paid_amount:null,outstanding_amount:null,actionable_status:'draft'};
const submitted={...base,status:'submitted',actionable_status:'awaiting_approval'};
const approved={...base,status:'approved',internal_number:'INV-0007',actionable_status:'partially_settled',obligation:{id:'o',is_cancelled:false,original_amount:'207.00'},journal:{id:'j',status:'posted'},vat:{status:'reviewed',review_id:'r',tax_date:'2026-10-01'},paid_amount:'50.00',outstanding_amount:'157.00',adjusted_amount:'207.00',settlements:[{id:'s1',amount:'50.00',transaction_date:'2026-10-05',description:'Bank transfer',note:null}]};
const cancelled={...base,status:'cancelled',actionable_status:'cancelled',cancellation:{cancelled_by_user_id:'u',cancelled_at:'2026-10-03T08:00:00Z',reason:'Issued by mistake'},adjustments:[]};
const purchase={...approved,internal_number:'PINV-0003',journal:{id:'j',status:'draft'},lines:[{...line,discount_amount:'0.00',vat_recoverability:'partially_recoverable',vat_recoverable_percent:'50.00'}]};
const caps={canView:true,canCreate:true,canEdit:true,canSubmit:true};
const all={...caps,canCancel:true,canDelete:true,canApprove:true,canPostJournal:true,canCreateSettlement:true,canViewObligations:true,canViewAccounting:true,canViewVat:true,canAdjust:true,canAdjustApprove:true};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});

function mockApi(invoice:Record<string,unknown>,extra:(key:string)=>Response|undefined=()=>undefined){
 const fetchMock=vi.fn((url:string,init?:RequestInit)=>{
  const key=`${init?.method??'GET'} ${url}`,custom=extra(key);
  if(custom)return Promise.resolve(custom);
  const path=url.split('?')[0];
  if(path==='/api/invoices')return Promise.resolve(json({invoices:[invoice],total:1}));
  if(path===`/api/invoices/${ID}`)return Promise.resolve(json({invoice}));
  if(path===`/api/invoices/${ID}/adjustments`)return Promise.resolve(json({adjustments:[]}));
  if(path==='/api/invoices/customers')return Promise.resolve(json({customers:[],suppliers:[]}));
  return Promise.resolve(json({},404));
 });
 vi.stubGlobal('fetch',fetchMock);
 return fetchMock;
}
async function openDetails(invoice:Record<string,unknown>,capabilities:Record<string,unknown>=all,direction:'sales'|'purchase'='sales',extra?:(key:string)=>Response|undefined){
 mockApi(invoice,extra);
 render(<InvoiceWorkspace {...capabilities as typeof caps} direction={direction} onNavigate={vi.fn()} onUnauthorized={vi.fn()}/>);
 fireEvent.click(await screen.findByText(String(invoice.internal_number??'REF-9')));
 return screen.findByRole('dialog');
}
const sectionNames=(dialog:HTMLElement)=>Array.from(dialog.querySelectorAll('details > summary')).map(x=>x.textContent);

beforeEach(async()=>{vi.restoreAllMocks();window.history.replaceState(null,'','/?page=sales');await i18n.changeLanguage('en')});

describe('Invoice details dialog layout',()=>{
 it.each([['draft',base,'Draft'],['submitted',submitted,'Awaiting approval'],['approved',approved,'Partially settled'],['cancelled',cancelled,'Cancelled']] as const)('shows the summary header and the three sections for a %s invoice',async(_,invoice,stage)=>{
  const dialog=await openDetails(invoice);
  const summary=within(dialog).getByRole('group',{name:'Invoice summary'});
  expect(summary).toHaveTextContent(stage);
  expect(summary).toHaveTextContent('Gulf Supplies');
  expect(summary).toHaveTextContent('01/10/2026');
  expect(summary).toHaveTextContent('207.00 SAR');
  expect(sectionNames(dialog)).toEqual(['Overview','Financial','Corrections']);
  expect(dialog.className).toContain('sales-invoices__detail');
 });

 it('labels an unnumbered submitted invoice accurately instead of calling it a draft',async()=>{
  const dialog=await openDetails(submitted);
  expect(within(dialog).getByRole('heading',{level:3})).toHaveTextContent('Submitted, number not issued yet');
 });

 it('shows only server values in the header: total, paid, outstanding and the adjusted amount when it differs',async()=>{
  const dialog=await openDetails({...approved,adjusted_amount:'180.00',outstanding_amount:'130.00'});
  const summary=within(dialog).getByRole('group',{name:'Invoice summary'});
  for(const part of ['Total207.00 SAR','Paid50.00 SAR','Outstanding130.00 SAR','Adjusted amount180.00 SAR'])expect(summary.textContent).toContain(part);
  cleanup();
  const draft=await openDetails(base);
  expect(within(draft).getByRole('group',{name:'Invoice summary'})).not.toHaveTextContent('Adjusted amount');
 });

 it('shows discounts per line and purchase VAT recoverability, with a label on every cell for the narrow layout',async()=>{
  const dialog=await openDetails(purchase,all,'purchase');
  const row=within(dialog).getByText('Consulting').closest('tr')!;
  expect(row).toHaveTextContent('Input VAT recovery');
  expect(row).toHaveTextContent('50.00%');
  for(const cell of Array.from(row.querySelectorAll('td')))expect(cell.getAttribute('data-label')).toBeTruthy();
  cleanup();
  const sales=await openDetails(base);
  const salesRow=within(sales).getByText('Consulting').closest('tr')!;
  expect(within(salesRow).getByText('20.00')).toBeInTheDocument();
  expect(salesRow).not.toHaveTextContent('Input VAT recovery');
 });

 it('keeps settlements in the Financial section and explains that it fills after approval',async()=>{
  const dialog=await openDetails(approved);
  const financial=dialog.querySelectorAll('details')[1]!;
  expect(within(financial as HTMLElement).getByTestId('invoice-settlements')).toHaveTextContent('Bank transfer');
  cleanup();
  const draft=await openDetails(base);
  expect(draft.querySelectorAll('details')[1]).toHaveTextContent('appear after the invoice is approved');
 });

 it('shows the cancellation history under Corrections',async()=>{
  const dialog=await openDetails(cancelled);
  const corrections=dialog.querySelectorAll('details')[2] as HTMLElement;
  expect(within(corrections).getByTestId('correction-history')).toHaveTextContent('Issued by mistake');
 });

 it('sections are native disclosure widgets that open and close',async()=>{
  const dialog=await openDetails(base);
  const overview=dialog.querySelector('details')!;
  expect(overview.open).toBe(true);
  fireEvent.click(overview.querySelector('summary')!);
  await waitFor(()=>expect(overview.open).toBe(false));
 });
});

describe('Invoice details actions',()=>{
 it('shows exactly one prominent action and keeps cancel/delete under "More"',async()=>{
  const dialog=await openDetails(base);
  const actions=dialog.querySelector('.sales-invoices__actions')!;
  expect(actions.querySelectorAll('.primary')).toHaveLength(1);
  expect(within(actions as HTMLElement).getByRole('button',{name:'Submit'})).toHaveClass('primary');
  expect(within(dialog).queryByRole('button',{name:'Cancel invoice'})).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button',{name:'Delete draft'})).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button',{name:'More'}));
  const menu=screen.getByRole('menu');
  expect(within(menu).getAllByRole('menuitem').map(x=>x.textContent)).toEqual(['Cancel invoice','Delete draft']);
 });

 it('offers no "More" menu without cancel or delete permission',async()=>{
  const dialog=await openDetails(base,caps);
  expect(within(dialog).queryByRole('button',{name:'More'})).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button',{name:'Submit'})).toBeInTheDocument();
 });

 it('supports keyboard use of the "More" menu: arrows, Escape closes only the menu and returns focus',async()=>{
  const dialog=await openDetails(base);
  const trigger=within(dialog).getByRole('button',{name:'More'});
  fireEvent.keyDown(trigger,{key:'ArrowDown'});
  const menu=await screen.findByRole('menu');
  expect(trigger).toHaveAttribute('aria-expanded','true');
  await waitFor(()=>expect(document.activeElement).toBe(within(menu).getByRole('menuitem',{name:'Cancel invoice'})));
  fireEvent.keyDown(document.activeElement!,{key:'ArrowDown'});
  expect(document.activeElement).toBe(within(menu).getByRole('menuitem',{name:'Delete draft'}));
  fireEvent.keyDown(document.activeElement!,{key:'ArrowDown'});
  expect(document.activeElement).toBe(within(menu).getByRole('menuitem',{name:'Cancel invoice'}));
  fireEvent.keyDown(document.activeElement!,{key:'Escape'});
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(document.activeElement).toBe(trigger);
 });

 it('moves focus into the cancellation step and keeps the reason requirement',async()=>{
  const dialog=await openDetails(submitted);
  fireEvent.click(within(dialog).getByRole('button',{name:'More'}));
  fireEvent.click(screen.getByRole('menuitem',{name:'Cancel invoice'}));
  const group=await screen.findByRole('group',{name:'Cancel this invoice?'});
  await waitFor(()=>expect(document.activeElement).toBe(within(group).getByLabelText('Cancellation reason')));
  expect(within(group).getByRole('button',{name:'Cancel invoice'})).toBeDisabled();
 });

 it('shows a blocking error inside the action area, next to the button that caused it',async()=>{
  const dialog=await openDetails(submitted,all,'sales',(key)=>key===`POST /api/invoices/${ID}/approve`?json({code:'INVOICE_MAPPING_MISSING',missing_keys:['receivable']},422):undefined);
  fireEvent.click(within(dialog).getByRole('button',{name:'Approve invoice'}));
  const alert=await screen.findByRole('alert');
  const footer=alert.closest('.sales-invoices__footer') as HTMLElement;
  expect(footer).not.toBeNull();
  expect(within(footer).getByTestId('mapping-missing')).toBeInTheDocument();
  expect(within(footer).getByRole('button',{name:'Approve invoice'})).toBeInTheDocument();
 });

 it('is fully translated in Arabic',async()=>{
  await i18n.changeLanguage('ar');
  const dialog=await openDetails(submitted);
  expect(sectionNames(dialog)).toEqual(['نظرة عامة','المالية','التصحيحات']);
  expect(within(dialog).getByRole('group',{name:'ملخص الفاتورة'})).toBeInTheDocument();
  expect(within(dialog).getByRole('heading',{level:3})).toHaveTextContent('مُرسلة، لم يُصدر رقمها بعد');
  fireEvent.click(within(dialog).getByRole('button',{name:'المزيد'}));
  expect(screen.getByRole('menu',{name:'إجراءات أخرى'})).toBeInTheDocument();
 });
});

