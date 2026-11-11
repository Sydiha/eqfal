import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MonthlyPayroll, normalizeAmount } from '../components/MonthlyPayroll';
import '../i18n';

const response=(data:unknown)=>({ok:true,status:200,json:async()=>data});
describe('Monthly Payroll draft visibility',()=>{
 beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(async()=>response({draft:{id:'d1',period_month:'2026-11-01',currency_code:'SAR',version:1,gross_earnings:'100.00',employee_deductions:'10.00',employer_contributions:'5.00',net_payable:'90.00'},employees:[{id:'x1',employee_id:'e1',employee_number:'001',display_name:'Ali',version:1,salary:'100.00',allowances:'0.00',legacy_allowances:'0.00',housing_allowance:'0.00',transportation_allowance:'0.00',other_allowance:'0.00',bonus:'0.00',overtime:'0.00',deductions:'10.00',employer_contributions:'5.00',gross_earnings:'100.00',net_payable:'90.00'}],available_employees:[{id:'e1',employee_number:'001',display_name:'Ali',is_active:true}]})));});
 afterEach(()=>vi.unstubAllGlobals());
 it('shows totals and employee without edit controls for view-only users',async()=>{render(<MonthlyPayroll capabilities={['payroll.view']} onUnauthorized={()=>{}}/>);await waitFor(()=>expect(screen.getAllByText(/90\.00/).length).toBeGreaterThan(0));expect(screen.queryByRole('button',{name:/تعديل|Edit/})).toBeNull();});
});

it('ignores an older month response after rapid period switching',async()=>{
 const pending=new Map<string,(x:unknown)=>void>();
 vi.stubGlobal('fetch',vi.fn((url:string)=>new Promise(resolve=>pending.set(url,resolve))));
 const ui=render(<MonthlyPayroll capabilities={['payroll.view']} onUnauthorized={()=>{}}/>);
 const input=document.querySelector('input[type="month"]') as HTMLInputElement;
 const first=input.value;
 const second=first==='2026-01'?'2026-02':'2026-01';
 const {fireEvent}=await import('@testing-library/react');
 fireEvent.change(input,{target:{value:second}});
 await waitFor(()=>expect(pending.size).toBe(2));
 pending.get(`/api/payroll/drafts?month=${second}-01`)!(response({draft:null,employees:[],available_employees:[]}));
 await screen.findByText(/لا توجد مسودة|No draft exists/);
 pending.get(`/api/payroll/drafts?month=${first}-01`)!(response({draft:{id:'old',gross_earnings:'999.00'},employees:[],available_employees:[]}));
 await waitFor(()=>expect(screen.queryByText(/999\.00/)).toBeNull());
 expect((document.querySelector('input[type=month]') as HTMLInputElement).value).toBe(second);
 ui.unmount();
});

it('keeps confirmation focus inside one dialog and restores focus on discard',async()=>{
 const {fireEvent}=await import('@testing-library/react');
 vi.stubGlobal('fetch',vi.fn(async()=>response({draft:{id:'d1',period_month:'2026-11-01',currency_code:'SAR',version:1,gross_earnings:'100.00',employee_deductions:'10.00',employer_contributions:'5.00',net_payable:'90.00'},employees:[{id:'x1',employee_id:'e1',employee_number:'001',display_name:'Ali',version:1,salary:'100.00',allowances:'0.00',legacy_allowances:'0.00',housing_allowance:'0.00',transportation_allowance:'0.00',other_allowance:'0.00',bonus:'0.00',overtime:'0.00',deductions:'10.00',employer_contributions:'5.00',gross_earnings:'100.00',net_payable:'90.00'}],available_employees:[{id:'e1',employee_number:'001',display_name:'Ali',is_active:true}]})));
 render(<MonthlyPayroll capabilities={['payroll.view','payroll.edit']} onUnauthorized={()=>{}}/>);
 await screen.findAllByText(/90\.00/);
 const trigger=screen.getAllByRole('button',{name:/تعديل|Edit/})[0]!;
 trigger.focus();fireEvent.click(trigger);
 const salary=screen.getByLabelText(/الراتب الأساسي|Base salary/);
 fireEvent.change(salary,{target:{value:'101.00'}});
 fireEvent.click(screen.getByRole('button',{name:/إلغاء|Cancel/}));
 expect(screen.getAllByRole('dialog')).toHaveLength(1);
 const confirm=screen.getByRole('dialog');
 fireEvent.keyDown(document,{key:'Tab'});
 expect(confirm.contains(document.activeElement)).toBe(true);
 fireEvent.keyDown(document,{key:'Escape'});
 expect(screen.getAllByRole('dialog')).toHaveLength(1);
 expect(screen.getByLabelText(/الراتب الأساسي|Base salary/)).toHaveValue('101.00');
 fireEvent.click(screen.getByRole('button',{name:/إلغاء|Cancel/}));
 fireEvent.click(screen.getByRole('button',{name:/تجاهل التغييرات|Discard changes/}));
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(document.activeElement).toBe(trigger);
});

afterEach(()=>vi.unstubAllGlobals());

it('accepts grouped positive amounts and submits canonical decimals',async()=>{
 const {fireEvent}=await import('@testing-library/react');
 const sent:unknown[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url:string,options?:RequestInit)=>{if(options?.body)sent.push(JSON.parse(String(options.body)));return response({draft:{id:'d1',period_month:'2026-11-01',currency_code:'SAR',version:1,gross_earnings:'6700.00',employee_deductions:'300.00',employer_contributions:'600.00',net_payable:'6400.00'},employees:[{id:'x1',employee_id:'e1',employee_number:'001',display_name:'Ali',version:1,salary:'5000.00',allowances:'1000.00',legacy_allowances:'0.00',housing_allowance:'1000.00',transportation_allowance:'0.00',other_allowance:'0.00',bonus:'500.00',overtime:'200.00',deductions:'300.00',employer_contributions:'600.00',gross_earnings:'6700.00',net_payable:'6400.00'}],available_employees:[{id:'e1',employee_number:'001',display_name:'Ali',is_active:true}]});}));
 render(<MonthlyPayroll capabilities={['payroll.view','payroll.edit']} onUnauthorized={()=>{}}/>);
 await screen.findAllByText(/6,400\.00/);
 fireEvent.click(screen.getAllByRole('button',{name:/تعديل|Edit/})[0]!);
 for(const [label,value] of [[/الراتب الأساسي|Base salary/,'5,000'],[/بدل السكن|Housing allowance/,'1,000'],[/المكافآت|Bonus/,'500'],[/العمل الإضافي|Overtime/,'200'],[/استقطاعات الموظف|Employee deductions/,'300'],[/مساهمات صاحب العمل|Employer contributions/,'600']] as const)fireEvent.change(screen.getByLabelText(label),{target:{value}});
 expect(screen.getByRole('dialog').textContent).toMatch(/6,700\.00/);
 expect(screen.getByRole('dialog').textContent).toMatch(/6,400\.00/);
 fireEvent.click(screen.getByRole('button',{name:/حفظ المسودة|Save draft/}));
 await waitFor(()=>expect(sent).toHaveLength(1));
 expect(sent[0]).toMatchObject({salary:'5000',housing_allowance:'1000',transportation_allowance:'0.00',other_allowance:'0.00',bonus:'500',overtime:'200',deductions:'300',employer_contributions:'600'});
});

it('keeps decimal precision and rejects malformed or negative amounts',()=>{
 expect(normalizeAmount('1,234.56')).toBe('1234.56');
 expect(normalizeAmount('0.01')).toBe('0.01');
 for(const value of ['1,00','1,234.567','-1','1.234','1,23,456','abc'])expect(normalizeAmount(value)).toBeNull();
});

it('reopens legacy allowances without assigning them to a category or changing totals',async()=>{
 const {fireEvent}=await import('@testing-library/react');
 const sent:Record<string,string>[]=[];
 const data={draft:{id:'d1',period_month:'2026-11-01',currency_code:'SAR',version:1,gross_earnings:'1123.47',employee_deductions:'0.02',employer_contributions:'0.03',net_payable:'1123.45'},employees:[{id:'x1',employee_id:'e1',employee_number:'001',display_name:'Ali',version:1,salary:'1000.01',allowances:'123.45',legacy_allowances:'123.45',housing_allowance:'0.00',transportation_allowance:'0.00',other_allowance:'0.00',bonus:'0.01',overtime:'0.00',deductions:'0.02',employer_contributions:'0.03',gross_earnings:'1123.47',net_payable:'1123.45'}],available_employees:[{id:'e1',employee_number:'001',display_name:'Ali',is_active:true}]};
 vi.stubGlobal('fetch',vi.fn(async(_url:string,options?:RequestInit)=>{if(options?.body)sent.push(JSON.parse(String(options.body)));return response(data);}));
 render(<MonthlyPayroll capabilities={['payroll.view','payroll.edit']} onUnauthorized={()=>{}}/>);
 await screen.findAllByText(/1,123\.45/);
 fireEvent.click(screen.getAllByRole('button',{name:/تعديل|Edit/})[0]!);
 expect(screen.getByText(/Legacy allowances \(unclassified\)|بدلات سابقة غير مصنفة/)).toBeInTheDocument();
 expect(screen.getByLabelText(/Housing allowance|بدل السكن/)).toHaveValue('0.00');
 expect(screen.getByRole('dialog').textContent).toMatch(/1,123\.47/);
 fireEvent.click(screen.getByRole('button',{name:/حفظ المسودة|Save draft/}));
 await waitFor(()=>expect(sent).toHaveLength(1));
 expect(sent[0]).not.toHaveProperty('allowances');
 expect(sent[0]).not.toHaveProperty('legacy_allowances');
 expect(sent[0]).toMatchObject({housing_allowance:'0.00',transportation_allowance:'0.00',other_allowance:'0.00'});
 await screen.findAllByText(/1,123\.45/);
 fireEvent.click(screen.getAllByRole('button',{name:/تعديل|Edit/})[0]!);
 expect(screen.getByLabelText(/Housing allowance|بدل السكن/)).toHaveValue('0.00');
 expect(screen.getByRole('dialog').textContent).toMatch(/1,123\.47/);
});
