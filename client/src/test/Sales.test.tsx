import{fireEvent,render,screen,waitFor,within}from'@testing-library/react';
import{beforeEach,describe,expect,it,vi}from'vitest';
import{Sales}from'../components/Sales';
import i18n from'../i18n';

const base={id:'d1',original_filename:'sale.pdf',status:'approved',document_date:'2026-08-01',reference_number:'INV-1',total_amount:'100.00',intake_note:null,counterparty_id:'c1',customer_name:'Customer',counterparty_type:'customer' as const,receivable_id:'o1',receivable_original_amount:'100.00',due_on:null,verification_status:'confirmed',receivable_cancelled:true,receivable_relationship:'linked_cancelled' as const,collected_amount:'20.00',remaining_amount:null,financial_state:null,settlement_history:[{id:'s1',amount:'20.00',transaction_date:'2026-08-02',description:'Transfer',bank_reference:null}]};
const active={...base,id:'d2',reference_number:'INV-2',receivable_cancelled:false,receivable_relationship:'linked_active' as const,financial_state:'partial' as const,due_on:'2026-08-15',remaining_amount:'80.00'};
const mockSales=(sales:object[])=>vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({sales}))));
const summaryRow=(reference:string|HTMLElement)=>(typeof reference==='string'?screen.getByText(reference):reference).closest('tr')!;

describe('Sales workspace',()=>{
 beforeEach(async()=>{vi.restoreAllMocks();await i18n.changeLanguage('en')});

 it('keeps a cancelled receivable historical, including settlement history, without replacement creation',async()=>{
  mockSales([base]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);
  const row=summaryRow(await screen.findByText('INV-1'));expect(within(row).getAllByText('Cancelled').length).toBeGreaterThan(0);expect(within(row).getByText('—')).toBeInTheDocument();
  fireEvent.click(row);expect(screen.getByText('Linked cancelled')).toBeInTheDocument();expect(screen.getByText('Transfer')).toBeInTheDocument();expect(screen.getByText('02/08/2026')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Create receivable'})).not.toBeInTheDocument();
 });

 it('opens and closes inline details by click and exposes selection and expansion state',async()=>{
  mockSales([base]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));
  expect(row).toHaveAttribute('aria-expanded','false');expect(row).toHaveAttribute('aria-selected','false');
  fireEvent.click(row);expect(row).toHaveAttribute('aria-expanded','true');expect(row).toHaveAttribute('aria-selected','true');expect(screen.getByRole('region',{name:'Sale details'})).toBeInTheDocument();
  fireEvent.click(row);expect(row).toHaveAttribute('aria-expanded','false');expect(screen.queryByRole('region',{name:'Sale details'})).not.toBeInTheDocument();
 });

 it.each(['Enter',' '])('opens inline details with the %s key',async key=>{
  mockSales([base]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));fireEvent.keyDown(row,{key});expect(row).toHaveAttribute('aria-expanded','true');
 });

 it('closes the first row when a second row opens',async()=>{
  mockSales([base,active]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);const first=summaryRow(await screen.findByText('INV-1')),second=summaryRow(screen.getByText('INV-2'));fireEvent.click(first);fireEvent.click(second);expect(first).toHaveAttribute('aria-expanded','false');expect(second).toHaveAttribute('aria-expanded','true');expect(screen.getAllByRole('region',{name:'Sale details'})).toHaveLength(1);
 });

 it('shows active financial state and formatted document and due dates, while preserving null display',async()=>{
  mockSales([base,active]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);const first=summaryRow(await screen.findByText('INV-1')),second=summaryRow(screen.getByText('INV-2'));expect(within(first).getByText('01/08/2026')).toBeInTheDocument();expect(within(second).getAllByText('Partial').length).toBeGreaterThan(0);expect(within(second).getByText(/15\/08\/2026/)).toBeInTheDocument();fireEvent.click(first);expect(within(screen.getByRole('region',{name:'Sale details'})).getAllByText('—').length).toBeGreaterThan(0);
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
  mockSales([{...base,intake_note:'Legacy note',counterparty_type:'supplier'}]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);const row=summaryRow(await screen.findByText('INV-1'));expect(within(row).getByText(/Supplier/)).toBeInTheDocument();fireEvent.click(row);expect(screen.getByText('Legacy note')).toBeInTheDocument();expect(screen.getByText(/Data integrity warning/)).toBeInTheDocument();expect(screen.getAllByText('Supplier').length).toBeGreaterThan(0);
 });

 it('keeps search and financial filtering behavior',async()=>{
  mockSales([base,active]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);fireEvent.change(await screen.findByRole('searchbox',{name:'Search sales'}),{target:{value:'INV-2'}});expect(screen.queryByText('INV-1')).not.toBeInTheDocument();expect(screen.getByText('INV-2')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));fireEvent.change(screen.getByRole('combobox',{name:'Financial state'}),{target:{value:'partial'}});expect(screen.queryByText('INV-1')).not.toBeInTheDocument();expect(screen.getByText('INV-2')).toBeInTheDocument();
 });

 it('renders required Arabic labels and localized Sales dates',async()=>{
  await i18n.changeLanguage('ar');mockSales([base]);render(<Sales canView canManage onUnauthorized={vi.fn()}/>);expect((await screen.findAllByText('ملغاة')).length).toBeGreaterThan(0);expect(screen.getByRole('columnheader',{name:'التحصيل'})).toBeInTheDocument();expect(screen.getByText('01‏/08‏/2026')).toBeInTheDocument();fireEvent.click(summaryRow('INV-1'));expect(screen.getByText('حالة التحقق')).toBeInTheDocument();expect(screen.getByText('مؤكد')).toBeInTheDocument();expect(screen.queryByText('confirmed')).not.toBeInTheDocument();expect(screen.getByText('اسم الملف الأصلي')).toBeInTheDocument();
 });
});
