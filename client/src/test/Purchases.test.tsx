import{fireEvent,render,screen,waitFor,within}from'@testing-library/react';
import{beforeEach,describe,expect,it,vi}from'vitest';
import{Purchases}from'../components/Purchases';
import i18n from'../i18n';

const base={id:'d1',document_type:'purchase' as const,original_filename:'purchase.pdf',status:'approved',document_date:'2026-08-01',reference_number:'INV-1',total_amount:'100.00',intake_note:null,counterparty_id:'c1',supplier_name:'Supplier',counterparty_type:'supplier' as const,payable_id:'o1',payable_original_amount:'100.00',due_on:null,verification_status:'confirmed',payable_cancelled:true,payable_relationship:'linked_cancelled' as const,paid_amount:'20.00',remaining_amount:null,financial_state:null,vat_review_status:'reviewed' as const,tax_date:'2026-08-01',vat_treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00',settlement_history:[{id:'s1',amount:'20.00',transaction_date:'2026-08-02',description:'Transfer',bank_reference:null}]};
const active={...base,id:'d2',document_type:'expense' as const,reference_number:'INV-2',payable_cancelled:false,payable_relationship:'linked_active' as const,financial_state:'partial' as const,due_on:'2026-08-15',remaining_amount:'80.00'};
const mockPurchases=(purchases:object[])=>vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({purchases}))));
const summaryRow=(reference:string|HTMLElement)=>(typeof reference==='string'?screen.getByText(reference):reference).closest('tr')!;

describe('Purchases workspace',()=>{
 beforeEach(async()=>{vi.restoreAllMocks();await i18n.changeLanguage('en')});

 it('keeps a cancelled payable historical, including settlement history, without replacement creation',async()=>{
  mockPurchases([base]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);
  const row=summaryRow(await screen.findByText('INV-1'));expect(within(row).getAllByText('Cancelled').length).toBeGreaterThan(0);expect(within(row).getByText('—')).toBeInTheDocument();
  fireEvent.click(row);expect(screen.getByText('Linked cancelled')).toBeInTheDocument();expect(screen.getByText('Transfer')).toBeInTheDocument();expect(screen.getByText('02/08/2026')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Create payable'})).not.toBeInTheDocument();
 });

 it('opens and closes inline details by click and exposes selection and expansion state',async()=>{
  mockPurchases([base]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));
  expect(row).toHaveAttribute('aria-expanded','false');expect(row).toHaveAttribute('aria-selected','false');
  fireEvent.click(row);expect(row).toHaveAttribute('aria-expanded','true');expect(row).toHaveAttribute('aria-selected','true');expect(screen.getByRole('region',{name:'Purchase details'})).toBeInTheDocument();
  fireEvent.click(row);expect(row).toHaveAttribute('aria-expanded','false');expect(screen.queryByRole('region',{name:'Purchase details'})).not.toBeInTheDocument();
 });

 it.each(['Enter',' '])('opens inline details with the %s key',async key=>{
  mockPurchases([base]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));fireEvent.keyDown(row,{key});expect(row).toHaveAttribute('aria-expanded','true');
 });

 it('closes the first row when a second row opens',async()=>{
  mockPurchases([base,active]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const first=summaryRow(await screen.findByText('INV-1')),second=summaryRow(screen.getByText('INV-2'));fireEvent.click(first);fireEvent.click(second);expect(first).toHaveAttribute('aria-expanded','false');expect(second).toHaveAttribute('aria-expanded','true');expect(screen.getAllByRole('region',{name:'Purchase details'})).toHaveLength(1);
 });

 it('shows active financial state and formatted document and due dates, while preserving null display',async()=>{
  mockPurchases([base,active]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const first=summaryRow(await screen.findByText('INV-1')),second=summaryRow(screen.getByText('INV-2'));expect(within(first).getByText('01/08/2026')).toBeInTheDocument();expect(within(second).getAllByText('Partial').length).toBeGreaterThan(0);expect(within(second).getAllByText(/15\/08\/2026/)[0]).toBeInTheDocument();fireEvent.click(first);expect(within(screen.getByRole('region',{name:'Purchase details'})).getAllByText('—').length).toBeGreaterThan(0);
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

 it('uses seven desktop columns, distinguishes purchase and expense badges, and renders every active financial state',async()=>{
  const states=['open','partial','paid','overdue'] as const;mockPurchases(states.map((financial_state,index)=>({...active,id:`state-${index}`,reference_number:`STATE-${index}`,financial_state,document_type:index%2?'expense':'purchase'})));render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);expect(await screen.findAllByRole('columnheader')).toHaveLength(7);expect(screen.getAllByText('Purchase').length).toBeGreaterThan(0);expect(screen.getAllByText('Expense').length).toBeGreaterThan(0);for(const label of ['Open','Partial','Paid','Overdue'])expect(screen.getAllByText(label).length).toBeGreaterThan(0);
 });

 it('shows read-only VAT context and responsive card hooks in the shared row truth',async()=>{
  mockPurchases([base]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));expect(row).toHaveClass('purchases-summary-row');expect(within(row).getByText('Purchase')).toHaveClass('purchases-type-badge');fireEvent.click(row);expect(screen.getByText('VAT review')).toBeInTheDocument();expect(screen.getByText('Input VAT')).toBeInTheDocument();expect(screen.getByText('15.00')).toBeInTheDocument();
 });

 it('renders required Arabic labels and localized Purchases dates',async()=>{
  await i18n.changeLanguage('ar');mockPurchases([{...base,payable_cancelled:false,financial_state:'paid'}]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));expect(within(row).getAllByText('مدفوعة').length).toBeGreaterThan(0);expect(screen.getByRole('columnheader',{name:'الدفع'})).toBeInTheDocument();expect(screen.getByText('01‏/08‏/2026')).toBeInTheDocument();fireEvent.click(row);expect(screen.getByText('المدفوع')).toBeInTheDocument();expect(screen.getByText('حالة التحقق')).toBeInTheDocument();expect(screen.getByText('مؤكد')).toBeInTheDocument();expect(screen.queryByText('confirmed')).not.toBeInTheDocument();expect(screen.getByText('اسم الملف الأصلي')).toBeInTheDocument();
 });

 it('keeps the English paid amount label in expanded details',async()=>{
  mockPurchases([{...base,payable_cancelled:false,financial_state:'paid'}]);render(<Purchases canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));expect(within(row).getAllByText('Paid').length).toBeGreaterThan(0);fireEvent.click(row);expect(within(screen.getByRole('region',{name:'Purchase details'})).getAllByText('Paid')).toHaveLength(2);
 });
});
