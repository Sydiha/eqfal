import{act,fireEvent,screen,waitFor,within}from'./test-utils';
import{render}from'./test-utils';
import{afterEach,beforeEach,describe,expect,it,vi}from'vitest';
import{Purchases}from'../components/Purchases';
import i18n from'../i18n';

const base={id:'d1',document_type:'purchase' as const,original_filename:'purchase.pdf',status:'approved',document_date:'2026-08-01',reference_number:'INV-1',total_amount:'100.00',intake_note:null,counterparty_id:'c1',supplier_name:'Supplier',counterparty_type:'supplier' as const,payable_id:'o1',payable_original_amount:'100.00',due_on:null,verification_status:'confirmed',payable_cancelled:true,payable_relationship:'linked_cancelled' as const,paid_amount:'20.00',remaining_amount:null,financial_state:null,vat_review_status:'reviewed' as const,tax_date:'2026-08-01',vat_treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00',settlement_history:[{id:'s1',amount:'20.00',transaction_date:'2026-08-02',description:'Transfer',bank_reference:null}]};
const active={...base,id:'d2',document_type:'expense' as const,reference_number:'INV-2',payable_cancelled:false,payable_relationship:'linked_active' as const,financial_state:'partial' as const,due_on:'2026-08-15',remaining_amount:'80.00'};
const mockPurchases=(purchases:object[])=>vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({purchases}))));
const summaryRow=(reference:string|HTMLElement)=>(typeof reference==='string'?screen.getByText(reference):reference).closest('tr')!;

describe('Purchases workspace',()=>{
 beforeEach(async()=>{vi.restoreAllMocks();window.history.replaceState(null,'','/?page=purchases');await i18n.changeLanguage('en')})
 afterEach(()=>window.history.replaceState(null,'','/'));

 it('derives the approved KPI strip from loaded rows and excludes cancelled outstanding balances',async()=>{
  mockPurchases([base,active,{...active,id:'d3',reference_number:'INV-3',total_amount:'50.50',paid_amount:'10.25',remaining_amount:'40.25',payable_cancelled:true,payable_relationship:'linked_cancelled'}]);
  render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);
  await screen.findByText('INV-1');
  expect(screen.getByText('Outstanding to suppliers').nextElementSibling).toHaveTextContent('80.00');
  expect(screen.getByText('Total paid').nextElementSibling).toHaveTextContent('50.25');
  expect(screen.getByText('Total purchases').nextElementSibling).toHaveTextContent('250.50');
 });

 it('keeps capitalisation gated to eligible approved purchase documents',async()=>{
  const capitalise=vi.fn();mockPurchases([base,active]);
  render(<Purchases canView canManage canCapitalise onCapitalise={capitalise} onUnauthorized={vi.fn()}/>);
  fireEvent.click(summaryRow(await screen.findByText('INV-1')));
  fireEvent.click(screen.getByRole('button',{name:'Capitalise as Fixed Asset'}));
  expect(capitalise).toHaveBeenCalledWith('d1');
  fireEvent.click(summaryRow('INV-2'));
  expect(screen.queryByRole('button',{name:'Capitalise as Fixed Asset'})).not.toBeInTheDocument();
 });

 it('keeps a cancelled payable historical, including settlement history, without replacement creation',async()=>{
  mockPurchases([base]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);
  const row=summaryRow(await screen.findByText('INV-1'));expect(within(row).getByText('Confirmed')).toHaveClass('purchases-verification--confirmed');expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
  fireEvent.click(row);expect(within(screen.getByRole('complementary',{name:'Purchase details'})).getByText('Linked cancelled')).toBeInTheDocument();expect(screen.getByText('Transfer')).toBeInTheDocument();expect(screen.getByText('02/08/2026')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Create payable'})).not.toBeInTheDocument();
 });

 it('opens and closes inline details by click and exposes selection and expansion state',async()=>{
  mockPurchases([base]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));
  expect(row).toHaveAttribute('aria-expanded','false');expect(row).toHaveAttribute('aria-selected','false');
  fireEvent.click(row);expect(row).toHaveAttribute('aria-expanded','true');expect(row).toHaveAttribute('aria-selected','true');expect(screen.getByRole('complementary',{name:'Purchase details'})).toBeInTheDocument();
  fireEvent.click(row);expect(row).toHaveAttribute('aria-expanded','false');expect(screen.queryByRole('complementary',{name:'Purchase details'})).not.toBeInTheDocument();
 });

 it.each(['Enter',' '])('opens inline details with the %s key',async key=>{
  mockPurchases([base]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));fireEvent.keyDown(row,{key});expect(row).toHaveAttribute('aria-expanded','true');
 });

 it('closes the first row when a second row opens',async()=>{
  mockPurchases([base,active]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const first=summaryRow(await screen.findByText('INV-1')),second=summaryRow(screen.getByText('INV-2'));fireEvent.click(first);fireEvent.click(second);expect(first).toHaveAttribute('aria-expanded','false');expect(second).toHaveAttribute('aria-expanded','true');expect(screen.getAllByRole('complementary',{name:'Purchase details'})).toHaveLength(1);
 });

 it('shows active financial state and formatted document and due dates, while preserving null display',async()=>{
  mockPurchases([base,active]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const first=summaryRow(await screen.findByText('INV-1')),second=summaryRow(screen.getByText('INV-2'));expect(within(first).getByText('01/08/2026')).toBeInTheDocument();expect(within(second).getByText('80.00')).toBeInTheDocument();expect(within(second).getByText(/15\/08\/2026/)).toBeInTheDocument();fireEvent.click(first);expect(within(screen.getByRole('complementary',{name:'Purchase details'})).getAllByText('—').length).toBeGreaterThan(0);
 });

 it('creates only an eligible approved complete unlinked purchase through the obligation path',async()=>{
  const eligible={...base,payable_id:null,payable_cancelled:false,payable_relationship:'not_created' as const,paid_amount:'0.00',settlement_history:[]};const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({purchases:[eligible]}))).mockResolvedValueOnce(new Response('{}',{status:201})).mockResolvedValueOnce(new Response(JSON.stringify({purchases:[]})));vi.stubGlobal('fetch',fetchMock);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);fireEvent.click(summaryRow(await screen.findByText('INV-1')));fireEvent.click(screen.getByRole('button',{name:'Create payable'}));await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(3));expect(fetchMock.mock.calls[1][0]).toBe('/api/obligations');expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({direction:'payable',document_id:'d1',counterparty_id:'c1',original_amount:'100.00',recognized_on:'2026-08-01',source_type:'document'});
 });

 it.each([
  ['cannot manage',{canManage:false}],
  ['missing counterparty',{counterparty_id:null}],
  ['wrong counterparty role',{counterparty_type:'customer'}],
  ['missing document date',{document_date:null}],
  ['missing total',{total_amount:null}],
 ])('does not offer creation when %s',async(_label,change)=>{
  const purchase={...base,payable_cancelled:false,payable_relationship:'not_created' as const,...change};mockPurchases([purchase]);render(<Purchases canView canManage={'canManage' in change?change.canManage:true} onUnauthorized={vi.fn()}/>);fireEvent.click(summaryRow(await screen.findByText('INV-1')));expect(screen.queryByRole('button',{name:'Create payable'})).not.toBeInTheDocument();
 });

 it('shows intake note and identifies a legacy customer-linked purchase instead of presenting it as a supplier',async()=>{
  mockPurchases([{...base,intake_note:'Legacy note',counterparty_type:'customer',supplier_name:'Legacy customer'}]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));expect(within(row).getByText(/Customer/)).toBeInTheDocument();fireEvent.click(row);expect(screen.getByText('Legacy note')).toBeInTheDocument();expect(screen.getByText(/Data integrity warning/)).toBeInTheDocument();expect(screen.getAllByText('Customer').length).toBeGreaterThan(0);
 });

 it('keeps search and financial filtering behavior',async()=>{
  mockPurchases([base,active]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);fireEvent.change(await screen.findByRole('searchbox',{name:'Search purchases'}),{target:{value:'INV-2'}});expect(screen.queryByText('INV-1')).not.toBeInTheDocument();expect(screen.getByText('INV-2')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));fireEvent.change(screen.getByRole('combobox',{name:'Financial state'}),{target:{value:'partial'}});expect(screen.queryByText('INV-1')).not.toBeInTheDocument();expect(screen.getByText('INV-2')).toBeInTheDocument();
 });

 it('uses the approved ten-column register with real totals and document type badges',async()=>{
  mockPurchases([base,active]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);expect(await screen.findAllByRole('columnheader')).toHaveLength(11);for(const label of ['Reference','Supplier','Invoice date','Due date','Taxable amount','Input VAT','Total amount','Paid','Remaining amount','Verification status'])expect(screen.getByRole('columnheader',{name:label})).toBeInTheDocument();expect(screen.getAllByText('Purchase').length).toBeGreaterThan(0);expect(screen.getAllByText('Expense').length).toBeGreaterThan(0);const totals=screen.getByText('Totals').closest('tr')!;expect(within(totals).getAllByText('200.00')).toHaveLength(2);expect(within(totals).getByText('30.00')).toBeInTheDocument();
 });

 it('shows read-only VAT context and responsive card hooks in the shared row truth',async()=>{
  mockPurchases([base]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));expect(row).toHaveClass('purchases-summary-row');expect(within(row).getByText('Purchase')).toHaveClass('purchases-type-badge');fireEvent.click(row);const detail=screen.getByRole('complementary',{name:'Purchase details'});expect(within(detail).getByRole('heading',{name:'VAT review'})).toBeInTheDocument();expect(within(detail).getByText('Input VAT')).toBeInTheDocument();expect(within(detail).getByText('15.00')).toBeInTheDocument();
 });

 it('renders required Arabic labels and localized Purchases dates',async()=>{
  await i18n.changeLanguage('ar');mockPurchases([{...base,payable_cancelled:false,financial_state:'paid'}]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));expect(within(row).getByText('مؤكد')).toBeInTheDocument();expect(screen.getByRole('columnheader',{name:'المسدد'})).toBeInTheDocument();expect(screen.getByText('01‏/08‏/2026')).toBeInTheDocument();fireEvent.click(row);expect(screen.getAllByText('المسدد')).toHaveLength(2);expect(within(screen.getByRole('complementary',{name:'تفاصيل المشتريات'})).getByText('حالة التحقق')).toBeInTheDocument();expect(within(screen.getByRole('complementary',{name:'تفاصيل المشتريات'})).getByText('مؤكد')).toBeInTheDocument();expect(screen.queryByText('confirmed')).not.toBeInTheDocument();expect(screen.getByText('اسم الملف الأصلي')).toBeInTheDocument();
 });

 it('keeps the English paid amount label in expanded details',async()=>{
  mockPurchases([{...base,payable_cancelled:false,financial_state:'paid'}]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));expect(within(row).getByText('Confirmed')).toBeInTheDocument();fireEvent.click(row);expect(within(screen.getByRole('complementary',{name:'Purchase details'})).getAllByText('Paid')).toHaveLength(2);
 });
 it('restores validated URL state and combines type, inclusive dates, payable, verification, and VAT filters',async()=>{
  window.history.replaceState(null,'','/?page=purchases&purchaseSearch=INV&purchaseSupplier=c1&purchaseFinancial=partial&purchaseReview=approved&purchaseType=expense&purchaseFrom=2026-08-01&purchaseTo=2026-08-01&purchasePayable=linked_active&purchaseVerification=confirmed&purchaseVatReview=reviewed&salesSearch=INV-1');mockPurchases([base,active]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);
  expect(await screen.findByRole('searchbox',{name:'Search purchases'})).toHaveValue('INV');expect(screen.getByLabelText('Supplier')).toHaveValue('c1');expect(screen.getByLabelText('Financial state')).toHaveValue('partial');expect(screen.getByLabelText('Document review state')).toHaveValue('approved');expect(screen.getByLabelText('Document type')).toHaveValue('expense');expect(screen.getByLabelText('From document date')).toHaveValue('2026-08-01');expect(screen.getByLabelText('To document date')).toHaveValue('2026-08-01');expect(screen.getByLabelText('Payable relationship')).toHaveValue('linked_active');expect(screen.getByLabelText('Verification status')).toHaveValue('confirmed');expect(screen.getByLabelText('VAT review')).toHaveValue('reviewed');expect(screen.getByText('INV-2')).toBeInTheDocument();expect(screen.queryByText('INV-1')).not.toBeInTheDocument();
 });

 it('filters each purchase discovery dimension, excludes null dates, reports zero, and clears only purchase state',async()=>{
  const unlinked={...base,id:'d3',reference_number:'NOTE-3',supplier_name:'Other',counterparty_id:'c2',document_date:null,status:'uploaded',document_type:'purchase' as const,payable_relationship:'not_created' as const,verification_status:'unconfirmed',vat_review_status:'missing' as const,financial_state:'open' as const};window.history.replaceState(null,'','/?page=purchases&safe=keep&salesSearch=keep');mockPurchases([base,active,unlinked]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);await screen.findByText('INV-1');
  fireEvent.change(screen.getByLabelText('Supplier'),{target:{value:'c2'}});expect(screen.getByText('NOTE-3')).toBeInTheDocument();fireEvent.change(screen.getByLabelText('Financial state'),{target:{value:'partial'}});expect(screen.getByText('0 purchases')).toBeInTheDocument();expect(screen.getByText('No purchases match the current filters.').closest('[data-state]')).toHaveAttribute('data-state','no-results');fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));
  for(const [label,value] of [['Document review state','uploaded'],['Document type','purchase'],['Payable relationship','not_created'],['Verification status','unconfirmed'],['VAT review','missing']] as const)fireEvent.change(screen.getByLabelText(label),{target:{value}});expect(screen.getByText('NOTE-3')).toBeInTheDocument();fireEvent.change(screen.getByLabelText('To document date'),{target:{value:'2026-08-31'}});expect(screen.getByText('0 purchases')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));expect(window.location.search).toBe('?page=purchases&safe=keep&salesSearch=keep');
 });

 it('ignores invalid values and unknown suppliers, restores popstate, and ignores sales parameters',async()=>{
  window.history.replaceState(null,'','/?page=purchases&purchaseSupplier=missing&purchaseFinancial=bad&purchaseReview=bad&purchaseType=sale&purchaseFrom=2026-02-31&purchasePayable=bad&purchaseVerification=bad&purchaseVatReview=bad&salesSearch=INV-2');mockPurchases([base,active]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);expect(await screen.findByText('2 purchases')).toBeInTheDocument();await waitFor(()=>expect(screen.getByLabelText('Supplier')).toHaveValue(''));expect(screen.getByLabelText('Document type')).toHaveValue('');expect(screen.getByLabelText('From document date')).toHaveValue('');expect(screen.getByRole('searchbox',{name:'Search purchases'})).toHaveValue('');act(()=>{window.history.pushState(null,'','/?page=purchases&purchaseSearch=INV-2');window.dispatchEvent(new PopStateEvent('popstate'))});expect(screen.getByRole('searchbox',{name:'Search purchases'})).toHaveValue('INV-2');expect(screen.queryByText('INV-1')).not.toBeInTheDocument();
 });

 it('distinguishes empty and no-results states while keeping purchase, expense, and edit entry actions compatible',async()=>{
  mockPurchases([]);const create=vi.fn();const {unmount}=render(<Purchases canView canManage canCreate onCreateDocument={create} onUnauthorized={vi.fn()}/>);expect((await screen.findByText('No purchases or expenses yet.')).closest('[data-state]')).toHaveAttribute('data-state','empty');fireEvent.click(screen.getAllByRole('button',{name:'Add purchase document +'})[0]);fireEvent.click(screen.getByRole('button',{name:'Purchase'}));expect(create).toHaveBeenCalledWith('purchase');unmount();
  const edit=vi.fn();mockPurchases([{...base,status:'uploaded'}]);render(<Purchases canView canManage canCreate canEdit onCreateDocument={create} onEditDocument={edit} onUnauthorized={vi.fn()}/>);fireEvent.click((await screen.findAllByRole('button',{name:'Add purchase document +'}))[0]);fireEvent.click(screen.getByRole('button',{name:'Expense'}));expect(create).toHaveBeenCalledWith('expense');fireEvent.change(screen.getByRole('searchbox',{name:'Search purchases'}),{target:{value:'missing'}});expect(screen.getByText('0 purchases')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));fireEvent.click(summaryRow('INV-1'));fireEvent.click(screen.getByRole('button',{name:'Edit'}));expect(edit).toHaveBeenCalledWith('d1');
 });

});
