import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MonthlyPayroll } from '../components/MonthlyPayroll';
import '../i18n';

const response=(data:unknown)=>({ok:true,status:200,json:async()=>data});
describe('Monthly Payroll draft visibility',()=>{
 beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(async()=>response({draft:{id:'d1',period_month:'2026-11-01',currency_code:'SAR',version:1,gross_earnings:'100.00',employee_deductions:'10.00',employer_contributions:'5.00',net_payable:'90.00'},employees:[{id:'x1',employee_id:'e1',employee_number:'001',display_name:'Ali',version:1,salary:'100.00',allowances:'0.00',bonus:'0.00',overtime:'0.00',deductions:'10.00',employer_contributions:'5.00',gross_earnings:'100.00',net_payable:'90.00'}],available_employees:[{id:'e1',employee_number:'001',display_name:'Ali',is_active:true}]})));});
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
 vi.stubGlobal('fetch',vi.fn(async()=>response({draft:{id:'d1',period_month:'2026-11-01',currency_code:'SAR',version:1,gross_earnings:'100.00',employee_deductions:'10.00',employer_contributions:'5.00',net_payable:'90.00'},employees:[{id:'x1',employee_id:'e1',employee_number:'001',display_name:'Ali',version:1,salary:'100.00',allowances:'0.00',bonus:'0.00',overtime:'0.00',deductions:'10.00',employer_contributions:'5.00',gross_earnings:'100.00',net_payable:'90.00'}],available_employees:[{id:'e1',employee_number:'001',display_name:'Ali',is_active:true}]})));
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
