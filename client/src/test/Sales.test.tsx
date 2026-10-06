import{act,fireEvent,screen,waitFor,within}from'./test-utils';
import{render}from'./test-utils';
import{afterEach,beforeEach,describe,expect,it,vi}from'vitest';
import{Sales}from'../components/Sales';
import i18n from'../i18n';

const base={id:'d1',original_filename:'sale.pdf',status:'approved',document_date:'2026-08-01',reference_number:'INV-1',total_amount:'100.00',intake_note:null,counterparty_id:'c1',customer_name:'Customer',counterparty_type:'customer' as const,receivable_id:'o1',receivable_original_amount:'100.00',due_on:null,verification_status:'confirmed',receivable_cancelled:true,receivable_relationship:'linked_cancelled' as const,collected_amount:'20.00',remaining_amount:null,financial_state:null,settlement_history:[{id:'s1',amount:'20.00',transaction_date:'2026-08-02',description:'Transfer',bank_reference:null}]};
const active={...base,id:'d2',reference_number:'INV-2',receivable_cancelled:false,receivable_relationship:'linked_active' as const,financial_state:'partial' as const,due_on:'2026-08-15',remaining_amount:'80.00'};
const mockSales=(sales:object[])=>vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({sales}))));
const summaryRow=(reference:string|HTMLElement)=>(typeof reference==='string'?screen.getByText(reference):reference).closest('tr')!;

describe('Sales workspace',()=>{
 beforeEach(async()=>{vi.restoreAllMocks();window.history.replaceState(null,'','/?page=sales');await i18n.changeLanguage('en')})
 afterEach(()=>window.history.replaceState(null,'','/'));

 it('keeps a cancelled receivable historical, including settlement history, without replacement creation',async()=>{
  mockSales([base]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);
  const row=summaryRow(await screen.findByText('INV-1'));expect(within(row).getAllByText('Cancelled').length).toBeGreaterThan(0);expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
  fireEvent.click(row);expect(within(screen.getByRole('complementary',{name:'Sale details'})).getByText('Linked cancelled')).toBeInTheDocument();expect(screen.getByText('Transfer')).toBeInTheDocument();expect(screen.getByText('02/08/2026')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Create receivable'})).not.toBeInTheDocument();
 });

 it('opens and closes inline details by click and exposes selection and expansion state',async()=>{
  mockSales([base]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));
  expect(row).toHaveAttribute('aria-expanded','false');expect(row).toHaveAttribute('aria-selected','false');
  fireEvent.click(row);expect(row).toHaveAttribute('aria-expanded','true');expect(row).toHaveAttribute('aria-selected','true');expect(screen.getByRole('complementary',{name:'Sale details'})).toBeInTheDocument();
  fireEvent.click(row);expect(row).toHaveAttribute('aria-expanded','false');expect(screen.queryByRole('complementary',{name:'Sale details'})).not.toBeInTheDocument();
 });

 it.each(['Enter',' '])('opens inline details with the %s key',async key=>{
  mockSales([base]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));fireEvent.keyDown(row,{key});expect(row).toHaveAttribute('aria-expanded','true');
 });

 it('closes the first row when a second row opens',async()=>{
  mockSales([base,active]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);const first=summaryRow(await screen.findByText('INV-1')),second=summaryRow(screen.getByText('INV-2'));fireEvent.click(first);fireEvent.click(second);expect(first).toHaveAttribute('aria-expanded','false');expect(second).toHaveAttribute('aria-expanded','true');expect(screen.getAllByRole('complementary',{name:'Sale details'})).toHaveLength(1);
 });

 it('shows active financial state and formatted document and due dates, while preserving null display',async()=>{
  mockSales([base,active]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);const first=summaryRow(await screen.findByText('INV-1')),second=summaryRow(screen.getByText('INV-2'));expect(within(first).getByText('01/08/2026')).toBeInTheDocument();expect(within(second).getAllByText('Partial').length).toBeGreaterThan(0);expect(within(second).getByText(/15\/08\/2026/)).toBeInTheDocument();fireEvent.click(first);expect(within(screen.getByRole('complementary',{name:'Sale details'})).getAllByText('—').length).toBeGreaterThan(0);
 });

 it('creates only an eligible approved complete unlinked sale through the obligation path',async()=>{
  const eligible={...base,receivable_id:null,receivable_cancelled:false,receivable_relationship:'not_created' as const,collected_amount:'0.00',settlement_history:[]};const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({sales:[eligible]}))).mockResolvedValueOnce(new Response('{}',{status:201})).mockResolvedValueOnce(new Response(JSON.stringify({sales:[]})));vi.stubGlobal('fetch',fetchMock);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);fireEvent.click(summaryRow(await screen.findByText('INV-1')));fireEvent.click(screen.getByRole('button',{name:'Create receivable'}));await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(3));expect(fetchMock.mock.calls[1][0]).toBe('/api/obligations');expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({direction:'receivable',document_id:'d1',counterparty_id:'c1',original_amount:'100.00',recognized_on:'2026-08-01',source_type:'document'});
 });

 it.each([
  ['cannot manage',{canManage:false}],
  ['missing counterparty',{counterparty_id:null}],
  ['wrong counterparty role',{counterparty_type:'supplier'}],
  ['missing document date',{document_date:null}],
  ['missing total',{total_amount:null}],
 ])('does not offer creation when %s',async(_label,change)=>{
  const sale={...base,receivable_cancelled:false,receivable_relationship:'not_created' as const,...change};mockSales([sale]);render(<Sales canView canManage={'canManage' in change?change.canManage:true} onUnauthorized={vi.fn()}/>);fireEvent.click(summaryRow(await screen.findByText('INV-1')));expect(screen.queryByRole('button',{name:'Create receivable'})).not.toBeInTheDocument();
 });

 it('shows intake note and identifies a legacy supplier-linked sale instead of presenting it as a customer',async()=>{
  mockSales([{...base,intake_note:'Legacy note',counterparty_type:'supplier'}]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));expect(within(row).getByText(/Supplier/)).toBeInTheDocument();fireEvent.click(row);const detail=screen.getByRole('complementary',{name:'Sale details'});expect(within(detail).getByText('Legacy note')).toBeInTheDocument();expect(within(detail).getByText(/Data integrity warning/)).toBeInTheDocument();expect(within(detail).getAllByText(/Supplier/).length).toBeGreaterThan(0);
 });

 it('keeps search and financial filtering behavior',async()=>{
  mockSales([base,active]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);fireEvent.change(await screen.findByRole('searchbox',{name:'Search sales'}),{target:{value:'INV-2'}});expect(screen.queryByText('INV-1')).not.toBeInTheDocument();expect(screen.getByText('INV-2')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));fireEvent.change(screen.getByRole('combobox',{name:'Financial state'}),{target:{value:'partial'}});expect(screen.queryByText('INV-1')).not.toBeInTheDocument();expect(screen.getByText('INV-2')).toBeInTheDocument();
 });

 it('renders required Arabic labels and localized Sales dates',async()=>{
  await i18n.changeLanguage('ar');mockSales([base]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);expect((await screen.findAllByText('ملغاة')).length).toBeGreaterThan(0);expect(screen.getByRole('columnheader',{name:'المبلغ المحصل'})).toBeInTheDocument();expect(screen.getByText('01‏/08‏/2026')).toBeInTheDocument();fireEvent.click(summaryRow('INV-1'));expect(within(screen.getByRole('complementary',{name:'تفاصيل البيع'})).getByText('حالة التحقق')).toBeInTheDocument();expect(within(screen.getByRole('complementary',{name:'تفاصيل البيع'})).getByText('مؤكد')).toBeInTheDocument();expect(screen.queryByText('confirmed')).not.toBeInTheDocument();expect(screen.getByText('اسم الملف الأصلي')).toBeInTheDocument();
 });
 it('restores validated URL filters, applies inclusive dates and all loaded relationship fields',async()=>{
  const open={...base,id:'d3',reference_number:'OPEN',document_date:'2026-08-02',receivable_cancelled:false,receivable_relationship:'not_created' as const,financial_state:'open' as const,verification_status:'unconfirmed',status:'uploaded'};
  window.history.replaceState(null,'','/?page=sales&salesSearch=inv&salesCustomer=c1&salesFinancial=partial&salesReview=approved&salesFrom=2026-08-01&salesTo=2026-08-15&salesReceivable=linked_active&salesVerification=confirmed&purchaseType=expense');
  mockSales([base,active,open]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);
  expect(await screen.findByRole('searchbox',{name:'Search sales'})).toHaveValue('inv');expect(screen.getByLabelText('Customer')).toHaveValue('c1');expect(screen.getByLabelText('Financial state')).toHaveValue('partial');expect(screen.getByLabelText('Document review state')).toHaveValue('approved');expect(screen.getByLabelText('From document date')).toHaveValue('2026-08-01');expect(screen.getByLabelText('To document date')).toHaveValue('2026-08-15');expect(screen.getByLabelText('Receivable relationship')).toHaveValue('linked_active');expect(screen.getByLabelText('Verification status')).toHaveValue('confirmed');expect(screen.getByText('INV-2')).toBeInTheDocument();expect(screen.queryByText('INV-1')).not.toBeInTheDocument();expect(window.location.search).toContain('purchaseType=expense');
 });

 it('supports every discovery control, combined zero results, and clear preserves page and unrelated state',async()=>{
  const unlinked={...base,id:'d3',reference_number:'NOTE-3',customer_name:'Other',counterparty_id:'c2',document_date:null,status:'uploaded',receivable_relationship:'not_created' as const,verification_status:'unconfirmed',financial_state:'open' as const};
  window.history.replaceState(null,'','/?page=sales&safe=keep');mockSales([base,active,unlinked]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);await screen.findByText('INV-1');
  fireEvent.change(screen.getByLabelText('Customer'),{target:{value:'c2'}});expect(screen.getByText('NOTE-3')).toBeInTheDocument();fireEvent.change(screen.getByLabelText('Financial state'),{target:{value:'partial'}});expect(screen.getByText('0 sales')).toBeInTheDocument();expect(screen.getByText('No sales match the current filters.').closest('[data-state]')).toHaveAttribute('data-state','no-results');
  fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));fireEvent.change(screen.getByLabelText('Document review state'),{target:{value:'uploaded'}});fireEvent.change(screen.getByLabelText('Receivable relationship'),{target:{value:'not_created'}});fireEvent.change(screen.getByLabelText('Verification status'),{target:{value:'unconfirmed'}});expect(screen.getByText('NOTE-3')).toBeInTheDocument();fireEvent.change(screen.getByLabelText('From document date'),{target:{value:'2026-08-01'}});expect(screen.getByText('0 sales')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));expect(window.location.search).toBe('?page=sales&safe=keep');
 });

 it('ignores invalid URL values and unknown customers, restores popstate, and isolates purchase parameters',async()=>{
  window.history.replaceState(null,'','/?page=sales&salesCustomer=missing&salesFinancial=bad&salesReview=bad&salesFrom=2026-02-31&salesReceivable=bad&salesVerification=bad&purchaseSearch=INV-2');mockSales([base,active]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);expect(await screen.findByText('2 sales')).toBeInTheDocument();await waitFor(()=>expect(screen.getByLabelText('Customer')).toHaveValue(''));expect(screen.getByLabelText('Financial state')).toHaveValue('');expect(screen.getByLabelText('From document date')).toHaveValue('');expect(screen.getByRole('searchbox',{name:'Search sales'})).toHaveValue('');
  act(()=>{window.history.pushState(null,'','/?page=sales&salesSearch=INV-2');window.dispatchEvent(new PopStateEvent('popstate'))});expect(screen.getByRole('searchbox',{name:'Search sales'})).toHaveValue('INV-2');expect(screen.queryByText('INV-1')).not.toBeInTheDocument();
 });

 it('distinguishes a genuinely empty sales dataset from filtered no-results and keeps entry actions compatible',async()=>{
  mockSales([]);const create=vi.fn();const {unmount}=render(<Sales canView canManage canCreate onCreateDocument={create} onUnauthorized={vi.fn()}/>);expect((await screen.findByText('No sales invoices yet.')).closest('[data-state]')).toHaveAttribute('data-state','empty');fireEvent.click(screen.getAllByRole('button',{name:'Add sales invoice +'})[0]);expect(create).toHaveBeenCalled();unmount();
  const edit=vi.fn();mockSales([{...base,status:'uploaded'}]);render(<Sales canView canManage canEdit onEditDocument={edit} onUnauthorized={vi.fn()}/>);fireEvent.change(await screen.findByRole('searchbox',{name:'Search sales'}),{target:{value:'missing'}});expect(screen.getByText('0 sales')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));fireEvent.click(summaryRow('INV-1'));fireEvent.click(screen.getByRole('button',{name:'Edit'}));expect(edit).toHaveBeenCalledWith('d1');
 });

 it('keeps the global period scope on rows and KPIs after clearing local filters',async()=>{
  const inP={...active,id:'a1',reference_number:'AUG-1',document_date:'2026-08-05',total_amount:'100.00',collected_amount:'0.00'};
  const inP2={...active,id:'a2',reference_number:'AUG-2',document_date:'2026-08-20',total_amount:'50.00',collected_amount:'0.00'};
  const outP={...active,id:'a3',reference_number:'SEP-1',document_date:'2026-09-05',total_amount:'700.00',collected_amount:'0.00'};
  mockSales([inP,inP2,outP]);
  const dateContextValue={companyId:'c',selectedFiscalYearId:'fy1',availableFiscalYears:[{id:'fy1',company_id:'c',name:'FY',start_date:'2026-01-01',end_date:'2026-12-31',status:'open'}],selectedPeriodId:'p8',availablePeriodsForSelectedYear:[{id:'p8',fiscal_year_id:'fy1',period_start:'2026-08-01',period_end:'2026-08-31',status:'open'}],periodMode:'specific' as const,isLoading:false,error:null,onSelectFiscalYear:async()=>{},onSelectPeriod:()=>{},loadFiscalYears:async()=>{},loadPeriodsForYear:async()=>{}};
  render(<Sales canView canManage onUnauthorized={vi.fn()}/>,{dateContextValue});
  expect(await screen.findByText('AUG-1')).toBeInTheDocument();expect(screen.queryByText('SEP-1')).not.toBeInTheDocument();expect(screen.getByText('150.00 SAR')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox',{name:'Search sales'}),{target:{value:'AUG-2'}});
  expect(screen.queryByText('AUG-1')).not.toBeInTheDocument();expect(screen.getByText('50.00 SAR')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:/clear/i}));
  expect(screen.getByText('AUG-1')).toBeInTheDocument();expect(screen.getByText('AUG-2')).toBeInTheDocument();expect(screen.queryByText('SEP-1')).not.toBeInTheDocument();expect(screen.getByText('150.00 SAR')).toBeInTheDocument();
 });

 it('keeps the global period scope on rows and KPIs after clear filters and browser history restore',async()=>{
  const mk=(id:string,date:string,total:string)=>({...active,id,reference_number:id.toUpperCase(),document_date:date,total_amount:total,collected_amount:'0.00'});
  mockSales([mk('aug-1','2026-08-05','100.00'),mk('aug-2','2026-08-20','50.00'),mk('sep-1','2026-09-05','700.00')]);
  const dateContextValue={companyId:'c',selectedFiscalYearId:'fy1',availableFiscalYears:[{id:'fy1',company_id:'c',name:'FY',start_date:'2026-01-01',end_date:'2026-12-31',status:'open'}],selectedPeriodId:'p8',availablePeriodsForSelectedYear:[{id:'p8',fiscal_year_id:'fy1',period_start:'2026-08-01',period_end:'2026-08-31',status:'open'}],periodMode:'specific' as const,isLoading:false,error:null,onSelectFiscalYear:async()=>{},onSelectPeriod:()=>{},loadFiscalYears:async()=>{},loadPeriodsForYear:async()=>{}};
  render(<Sales canView canManage onUnauthorized={vi.fn()}/>,{dateContextValue});
  expect(await screen.findByText('AUG-1')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox',{name:'Search sales'}),{target:{value:'AUG-2'}});
  fireEvent.click(screen.getByRole('button',{name:/clear/i}));
  expect(window.location.search).not.toContain('salesFrom');
  act(()=>{window.dispatchEvent(new PopStateEvent('popstate'))});
  expect(screen.getByText('AUG-1')).toBeInTheDocument();expect(screen.getByText('AUG-2')).toBeInTheDocument();expect(screen.queryByText('SEP-1')).not.toBeInTheDocument();expect(screen.getByText('150.00 SAR')).toBeInTheDocument();
 });

});
