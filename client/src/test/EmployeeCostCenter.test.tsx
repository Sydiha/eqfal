import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '../i18n';
import i18n from '../i18n';
import { EmployeeCostCenter } from '../components/EmployeeCostCenter';
import { EmployeeCostPayments } from '../components/EmployeeCostPayments';

beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});
const onUnauthorized=vi.fn();

const employee={id:'e1',employee_number:'E1',display_name:'Employee One',employment_start:'2025-01-01',employment_end:null,is_active:true,version:1};
const fiscalYear={id:'fy1',name:'FY 2026',start_date:'2026-01-01',end_date:'2026-12-31',status:'open'};
const cost=(id:string,status:'draft'|'approved')=>({id,employee_id:'e1',employee_number:'E1',display_name:'Employee One',category:'salary',nature:'earning' as const,currency_code:'SAR',total_amount:'100.00',service_period_start:'2026-01-01',service_period_end:'2026-01-31',description:'January salary',status,version:1,supersedes_id:null,correction_reason:null,allocations:[{id:`${id}-allocation`,fiscal_year_id:'fy1',allocation_month:'2026-01-01',amount:'100.00'}]});
function mockApi(records:unknown[]=[],failure:{path:string;status:number;body:Record<string,unknown>}|null=null){
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
    const failed=method!=='GET'&&failure?.path===url;
    return new Response(JSON.stringify(failed?failure.body:body),{status:failed?failure.status:method==='GET'?200:201});
  }));
  return writes;
}

describe('Employee Cost Center',()=>{
  it('does not show bank payment reconciliation to users holding only allocation authority',async()=>{
    mockApi([cost('approved-1','approved')]);
    render(<EmployeeCostCenter capabilities={['employee.view','employee_cost.view','employee_cost.payment.allocate','employee_cost.salary.view','bank.view']} onUnauthorized={onUnauthorized}/>);
    await screen.findByRole('heading',{name:'Employee Cost Center'});
    expect(screen.queryByRole('heading',{name:'Bank payment reconciliation'})).toBeNull();
  });

  it('shows bank payment reconciliation to read-only users without settlement controls',async()=>{
    mockApi([cost('approved-1','approved')]);
    render(<EmployeeCostCenter capabilities={['employee.view','employee_cost.view','employee_cost.payment.view','employee_cost.salary.view','bank.view']} onUnauthorized={onUnauthorized}/>);
    expect(await screen.findByRole('heading',{name:'Bank payment reconciliation'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Save payment allocation'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Save reversal'})).toBeNull();
  });
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
    expect(await within(screen.getByRole('dialog')).findByText('Total Amount must equal the sum of monthly allocations.')).toBeInTheDocument();
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
    expect(await within(screen.getByRole('dialog')).findByText('يجب أن يساوي إجمالي المبلغ مجموع التوزيعات الشهرية.')).toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('preserves total and monthly allocation when editing and correcting existing costs',async()=>{
    const writes=mockApi([cost('draft-1','draft'),cost('approved-1','approved')]);
    render(<EmployeeCostCenter capabilities={['employee.view','employee_cost.view','employee_cost.create','employee_cost.approve','employee_cost.correct','employee_cost.salary.view']} onUnauthorized={onUnauthorized}/>);
    await screen.findByRole('heading',{name:'Employee Cost Center'});
    const draftRow=screen.getByRole('row',{name:/Draft/});
    fireEvent.click(within(draftRow).getByRole('button',{name:'Edit'}));
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

  it('uses translated actions, automatic report filters, and current cost guidance',async()=>{
    const writes=mockApi([cost('approved-1','approved')]);
    render(<EmployeeCostCenter capabilities={['employee.view','employee_cost.view','employee_cost.salary.view']} onUnauthorized={onUnauthorized}/>);
    await screen.findByRole('heading',{name:'Employee Cost Center'});
    expect(screen.getByText(/Current approved costs are listed here/)).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Correction history'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'personalPayments.history'})).not.toBeInTheDocument();
    expect(screen.getByLabelText('Fiscal year')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Show report'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Fiscal year'}));
    expect(screen.queryByLabelText('Allocation month')).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('labels current and superseded correction history in Arabic',async()=>{
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
      const url=String(input);
      const body=url==='/api/employees'?{employees:[employee]}:url==='/api/employee-costs/fiscal-years'?{fiscal_years:[fiscalYear]}:url==='/api/employee-costs'?{records:[cost('current','approved')]}:url.endsWith('/history')?{history:[{...cost('old','approved'),supersedes_id:null},{...cost('current','approved'),supersedes_id:'old'}]}:{rows:[]};
      return new Response(JSON.stringify(body),{status:200});
    }));
    render(<EmployeeCostCenter capabilities={['employee.view','employee_cost.view','employee_cost.salary.view']} onUnauthorized={onUnauthorized}/>);
    await screen.findByRole('heading',{name:'مركز تكاليف الموظفين'});
    fireEvent.click(screen.getByRole('button',{name:'سجل التصحيحات'}));
    expect(await screen.findByText('تصحيح مستبدل')).toBeInTheDocument();
    expect(screen.getByText('التكلفة المعتمدة الحالية')).toBeInTheDocument();
    expect(screen.queryByText('personalPayments.history')).not.toBeInTheDocument();
  });

  it('keeps correction actions outside the scrolling fields with multiple allocations',async()=>{
    mockApi([cost('approved-1','approved')]);
    render(<EmployeeCostCenter capabilities={['employee.view','employee_cost.view','employee_cost.approve','employee_cost.correct','employee_cost.salary.view']} onUnauthorized={onUnauthorized}/>);
    await screen.findByRole('heading',{name:'Employee Cost Center'});
    fireEvent.click(screen.getByRole('button',{name:'Correct approved cost'}));
    const dialog=screen.getByRole('dialog');
    for(let i=0;i<3;i++)fireEvent.click(within(dialog).getByRole('button',{name:'Add month'}));
    const form=dialog.querySelector('.ecc-dialog-form');
    const body=form?.querySelector('.ecc-dialog-body');
    const footer=form?.querySelector('.ecc-dialog-actions');
    expect(body).toBeInTheDocument();
    expect(footer).toBeInTheDocument();
    expect(body?.parentElement).toBe(form);
    expect(footer?.parentElement).toBe(form);
    expect(body).toContainElement(within(dialog).getByLabelText('Correction reason'));
    expect(body?.querySelectorAll('.ecc-allocation')).toHaveLength(4);
    expect(footer).toContainElement(within(dialog).getByRole('button',{name:'Cancel'}));
    expect(footer).toContainElement(within(dialog).getByRole('button',{name:'Correct approved cost'}));
  });

  it('keeps payment history actions inside a native table cell',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{
      const url=String(input);
      const body=url.endsWith('/payments')?{payments:[{id:'p1',allocation_type:'payment',cost_allocation_id:'a1',bank_transaction_id:'b1',transaction_date:'2026-01-01',amount:'20.00',beneficiary_type:'employee',counterparty_name:null,bank_reference:null,bank_description:null,reason:null,note:null,reverses_allocation_id:null,reversible_amount:'20.00'}]}:url.includes('/reconciliation/')?{rows:[],paid_as_of:'2026-01-31'}:{bank_transactions:[],refund_transactions:[],counterparties:[]};
      return new Response(JSON.stringify(body),{status:200});
    }));
    render(<EmployeeCostPayments records={[cost('approved-1','approved')]} years={[fiscalYear]} capabilities={['employee_cost.view','employee_cost.payment.view','employee_cost.payment.reverse','employee_cost.salary.view','bank.view']} onUnauthorized={onUnauthorized}/>);
    const reverse=await screen.findByRole('button',{name:'Record refund / reversal'});
    const cell=reverse.closest('td');
    expect(cell).toHaveClass('ecc-action-cell');
    expect(cell).not.toHaveClass('ecc-actions');
    expect(cell?.querySelector('.ecc-actions')).toContainElement(reverse);
  });

  it('shows the active-payment correction rejection inside the open modal in English and Arabic',async()=>{
    const path='/api/employee-costs/approved-1/corrections';
    const failure={path,status:409,body:{code:'EMPLOYEE_COST_PAYMENT_ACTIVE'}};
    const capabilities=['employee.view','employee_cost.view','employee_cost.approve','employee_cost.correct','employee_cost.salary.view'];
    const februaryCost={...cost('approved-1','approved'),service_period_start:'2026-02-01',service_period_end:'2026-02-28',allocations:[{id:'approved-feb-allocation',fiscal_year_id:'fy1',allocation_month:'2026-02-01',amount:'100.00'}]};
    const englishWrites=mockApi([februaryCost],failure);
    const english=render(<EmployeeCostCenter capabilities={capabilities} onUnauthorized={onUnauthorized}/>);
    await screen.findByRole('heading',{name:'Employee Cost Center'});
    fireEvent.click(screen.getByRole('button',{name:'Correct approved cost'}));
    let dialog=screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Total amount'),{target:{value:'110'}});
    fireEvent.change(within(dialog).getByLabelText('Month amount'),{target:{value:'110'}});
    fireEvent.change(within(dialog).getByLabelText('Correction reason'),{target:{value:'Correct amount after full payment'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Correct approved cost'}));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This cost has active payments. Record full reversals for all payments before submitting the correction.');
    expect(englishWrites.some(w=>w.url===path&&w.method==='POST')).toBe(true);
    expect(englishWrites.find(w=>w.url===path)?.body.record).toMatchObject({total_amount:'110.00',allocations:[{allocation_month:'2026-02-01',amount:'110'}]});
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    english.unmount();
    await i18n.changeLanguage('ar');
    const arabicWrites=mockApi([februaryCost],failure);
    render(<EmployeeCostCenter capabilities={capabilities} onUnauthorized={onUnauthorized}/>);
    await screen.findByRole('heading',{name:'مركز تكاليف الموظفين'});
    fireEvent.click(screen.getByRole('button',{name:'تصحيح تكلفة معتمدة'}));
    dialog=screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('إجمالي المبلغ'),{target:{value:'110'}});
    fireEvent.change(within(dialog).getByLabelText('مبلغ الشهر'),{target:{value:'110'}});
    fireEvent.change(within(dialog).getByLabelText('سبب التصحيح'),{target:{value:'تصحيح المبلغ بعد السداد'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'تصحيح تكلفة معتمدة'}));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('لدى هذه التكلفة مدفوعات نشطة. سجّل عمليات عكس كاملة لجميع المدفوعات قبل إرسال التصحيح.');
    expect(arabicWrites.some(w=>w.url===path&&w.method==='POST')).toBe(true);
    expect(arabicWrites.find(w=>w.url===path)?.body.record).toMatchObject({total_amount:'110.00',allocations:[{allocation_month:'2026-02-01',amount:'110'}]});
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
