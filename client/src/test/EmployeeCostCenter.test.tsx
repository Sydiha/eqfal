import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '../i18n';
import i18n from '../i18n';
import { EmployeeCostCenter } from '../components/EmployeeCostCenter';

beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});
const onUnauthorized=vi.fn();

const employee={id:'e1',employee_number:'E1',display_name:'Employee One',employment_start:'2025-01-01',employment_end:null,is_active:true,version:1};
const fiscalYear={id:'fy1',name:'FY 2026',start_date:'2026-01-01',end_date:'2026-12-31',status:'open'};
const cost=(id:string,status:'draft'|'approved')=>({id,employee_id:'e1',employee_number:'E1',display_name:'Employee One',category:'salary',nature:'earning',currency_code:'SAR',total_amount:'100.00',service_period_start:'2026-01-01',service_period_end:'2026-01-31',description:'January salary',status,version:1,supersedes_id:null,correction_reason:null,allocations:[{id:`${id}-allocation`,fiscal_year_id:'fy1',allocation_month:'2026-01-01',amount:'100.00'}]});
function mockApi(records:unknown[]=[]){
  const writes:Array<{url:string;method:string;body:Record<string,unknown>}> = [];
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input),method=init?.method??'GET';
    let body:unknown={};
    if(method!=='GET'){
      const data=JSON.parse(String(init?.body??'{}')) as Record<string,unknown>;
      writes.push({url,method,body:data});
      body={record:{id:'new-cost'}};
    }else if(url==='/api/employees')body={employees:[employee]};
    else if(url==='/api/employee-costs/fiscal-years')body={fiscal_years:[fiscalYear]};
    else if(url==='/api/employee-costs')body={records};
    else if(url.includes('/reports/'))body={rows:[]};
    return new Response(JSON.stringify(body),{status:method==='GET'?200:201});
  }));
  return writes;
}

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

  it('accepts a SAR 100 cost with an equal monthly allocation and keeps nature derived from category',async()=>{
    const writes=mockApi();
    render(<EmployeeCostCenter capabilities={['employee.view','employee_cost.view','employee_cost.create','employee_cost.salary.view']} onUnauthorized={onUnauthorized}/>);
    await screen.findByRole('heading',{name:'Employee Cost Center'});
    fireEvent.click(screen.getByRole('button',{name:'Record cost'}));
    const total=await screen.findByLabelText('Total amount');
    expect(total).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('Cost type')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Cost type')).toHaveValue('Employee earnings');
    fireEvent.change(total,{target:{value:'100'}});
    fireEvent.change(screen.getByLabelText('Month amount'),{target:{value:'100'}});
    fireEvent.change(screen.getByLabelText('Description'),{target:{value:'January salary'}});
    fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
    await waitFor(()=>expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({url:'/api/employee-costs',method:'POST',body:{employee_id:'e1',record:{total_amount:'100.00',nature:'earning',allocations:[{fiscal_year_id:'fy1',allocation_month:expect.any(String),amount:'100'}]}}});
  });

  it('rejects mismatched total and monthly allocations before submission with a bilingual message',async()=>{
    let writes=mockApi();
    const first=render(<EmployeeCostCenter capabilities={['employee.view','employee_cost.view','employee_cost.create','employee_cost.salary.view']} onUnauthorized={onUnauthorized}/>);
    await screen.findByRole('heading',{name:'Employee Cost Center'});
    fireEvent.click(screen.getByRole('button',{name:'Record cost'}));
    fireEvent.change(await screen.findByLabelText('Total amount'),{target:{value:'100'}});
    fireEvent.change(screen.getByLabelText('Month amount'),{target:{value:'99.99'}});
    fireEvent.change(screen.getByLabelText('Description'),{target:{value:'January salary'}});
    fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
    expect(await screen.findByText('Total Amount must equal the sum of monthly allocations.')).toBeInTheDocument();
    expect(writes).toHaveLength(0);

    first.unmount();
    await i18n.changeLanguage('ar');
    writes=mockApi();
    render(<EmployeeCostCenter capabilities={['employee.view','employee_cost.view','employee_cost.create','employee_cost.salary.view']} onUnauthorized={onUnauthorized}/>);
    await screen.findByRole('heading',{name:'مركز تكاليف الموظفين'});
    fireEvent.click(screen.getByRole('button',{name:'تسجيل تكلفة'}));
    fireEvent.change(await screen.findByLabelText('إجمالي المبلغ'),{target:{value:'100'}});
    fireEvent.change(screen.getByLabelText('مبلغ الشهر'),{target:{value:'99.99'}});
    fireEvent.change(screen.getByLabelText('الوصف'),{target:{value:'راتب يناير'}});
    fireEvent.click(screen.getByRole('button',{name:'حفظ المسودة'}));
    expect(await screen.findByText('يجب أن يساوي إجمالي المبلغ مجموع التوزيعات الشهرية.')).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('preserves total and monthly allocation when editing and correcting existing costs',async()=>{
    const writes=mockApi([cost('draft-1','draft'),cost('approved-1','approved')]);
    render(<EmployeeCostCenter capabilities={['employee.view','employee_cost.view','employee_cost.create','employee_cost.approve','employee_cost.correct','employee_cost.salary.view']} onUnauthorized={onUnauthorized}/>);
    await screen.findByRole('heading',{name:'Employee Cost Center'});
    const draftRow=screen.getByRole('row',{name:/Draft/});
    fireEvent.click(within(draftRow).getByRole('button',{name:'common.edit'}));
    const editDialog=screen.getByRole('dialog');
    expect(within(editDialog).getByLabelText('Total amount')).toHaveValue(100);
    expect(within(editDialog).getByLabelText('Month amount')).toHaveValue(100);
    fireEvent.click(within(editDialog).getByRole('button',{name:'Save draft'}));
    await waitFor(()=>expect(writes.some(w=>w.method==='PATCH')).toBe(true));
    expect(writes.find(w=>w.method==='PATCH')?.body.record).toMatchObject({total_amount:'100.00',allocations:[{fiscal_year_id:'fy1',allocation_month:'2026-01-01',amount:'100.00'}]});

    fireEvent.click(screen.getByRole('button',{name:'Correct approved cost'}));
    const correctionDialog=screen.getByRole('dialog');
    expect(within(correctionDialog).getByLabelText('Total amount')).toHaveValue(100);
    expect(within(correctionDialog).getByLabelText('Month amount')).toHaveValue(100);
    fireEvent.change(within(correctionDialog).getByLabelText('Correction reason'),{target:{value:'Retain allocation amounts'}});
    fireEvent.click(within(correctionDialog).getByRole('button',{name:'Correct approved cost'}));
    await waitFor(()=>expect(writes.some(w=>w.url==='/api/employee-costs/approved-1/corrections')).toBe(true));
    expect(writes.find(w=>w.url==='/api/employee-costs/approved-1/corrections')?.body.record).toMatchObject({total_amount:'100.00',allocations:[{fiscal_year_id:'fy1',allocation_month:'2026-01-01',amount:'100.00'}]});
  });
});
