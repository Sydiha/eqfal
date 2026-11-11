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
