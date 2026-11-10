import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../i18n';
import i18n from '../i18n';
import { EmployeeCostCenter } from '../components/EmployeeCostCenter';

beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});
const onUnauthorized=vi.fn();

describe('Employee Cost Center',()=>{
  it('labels report values as recorded costs and excludes salary data without its dedicated capability',async()=>{
    const responses:Record<string,unknown>={
      '/api/employees':{employees:[{id:'e1',employee_number:'E1',display_name:'Employee One',employment_start:null,employment_end:null,is_active:true,version:1}]},
      '/api/employee-costs/fiscal-years':{fiscal_years:[{id:'fy1',name:'FY 2026',start_date:'2026-01-01',end_date:'2026-12-31',status:'open'}]},
      '/api/employee-costs':{records:[]},
    };
    vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(new Response(JSON.stringify(url.includes('/reports/')?{rows:[{employee_id:'e1',employee_number:'E1',display_name:'Employee One',category:'employer_gosi',nature:'employer_cost',allocation_month:'2026-11-01',currency_code:'SAR',amount:'50.00'}]}:responses[url]),{status:200}))));
    render(<EmployeeCostCenter capabilities={['employee.view','employee_cost.view']} onUnauthorized={onUnauthorized}/>);
    expect(await screen.findByRole('heading',{name:'Employee Cost Center'})).toBeInTheDocument();
    expect(await screen.findByText('Employer GOSI')).toBeInTheDocument();
    expect(screen.getAllByText('Approved recorded costs').length).toBeGreaterThan(0);
    expect(screen.getByText('Not verified bank payments')).toBeInTheDocument();
    expect(screen.getByText('Not posted accounting expenses')).toBeInTheDocument();
    expect(screen.getByText('Earnings and deductions require the dedicated salary visibility permission.')).toBeInTheDocument();
    expect(screen.queryByText('Salary')).not.toBeInTheDocument();
  });

  it('renders the employee workspace in Arabic',async()=>{
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({employees:[]}),{status:200})));
    render(<EmployeeCostCenter capabilities={['employee.view']} onUnauthorized={onUnauthorized}/>);
    expect(await screen.findByRole('heading',{name:'مركز تكاليف الموظفين'})).toBeInTheDocument();
    expect(screen.getByText('تكاليف مسجلة ومعتمدة')).toBeInTheDocument();
    expect(screen.getByText('ليست مدفوعات بنكية مؤكدة')).toBeInTheDocument();
  });
});
