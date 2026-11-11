import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MonthlyPayroll, normalizeAmount } from '../components/MonthlyPayroll';
import '../i18n';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const response=(data:unknown)=>({ok:true,status:200,json:async()=>data});
describe('Monthly Payroll draft visibility',()=>{
 beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(async()=>response({draft:{id:'d1',period_month:'2026-11-01',currency_code:'SAR',version:1,status:'draft',approved_at:null,approved_by_email:null,gross_earnings:'100.00',employee_deductions:'10.00',employer_contributions:'5.00',net_payable:'90.00'},employees:[{id:'x1',employee_id:'e1',employee_number:'001',display_name:'Ali',version:1,salary:'100.00',allowances:'0.00',legacy_allowances:'0.00',housing_allowance:'0.00',transportation_allowance:'0.00',other_allowance:'0.00',bonus:'0.00',overtime:'0.00',deductions:'10.00',employer_contributions:'5.00',gross_earnings:'100.00',net_payable:'90.00'}],available_employees:[{id:'e1',employee_number:'001',display_name:'Ali',is_active:true}]})));});
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
 vi.stubGlobal('fetch',vi.fn(async()=>response({draft:{id:'d1',period_month:'2026-11-01',currency_code:'SAR',version:1,status:'draft',approved_at:null,approved_by_email:null,gross_earnings:'100.00',employee_deductions:'10.00',employer_contributions:'5.00',net_payable:'90.00'},employees:[{id:'x1',employee_id:'e1',employee_number:'001',display_name:'Ali',version:1,salary:'100.00',allowances:'0.00',legacy_allowances:'0.00',housing_allowance:'0.00',transportation_allowance:'0.00',other_allowance:'0.00',bonus:'0.00',overtime:'0.00',deductions:'10.00',employer_contributions:'5.00',gross_earnings:'100.00',net_payable:'90.00'}],available_employees:[{id:'e1',employee_number:'001',display_name:'Ali',is_active:true}]})));
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
 vi.stubGlobal('fetch',vi.fn(async(_url:string,options?:RequestInit)=>{if(options?.body)sent.push(JSON.parse(String(options.body)));return response({draft:{id:'d1',period_month:'2026-11-01',currency_code:'SAR',version:1,status:'draft',approved_at:null,approved_by_email:null,gross_earnings:'6700.00',employee_deductions:'300.00',employer_contributions:'600.00',net_payable:'6400.00'},employees:[{id:'x1',employee_id:'e1',employee_number:'001',display_name:'Ali',version:1,salary:'5000.00',allowances:'1000.00',legacy_allowances:'0.00',housing_allowance:'1000.00',transportation_allowance:'0.00',other_allowance:'0.00',bonus:'500.00',overtime:'200.00',deductions:'300.00',employer_contributions:'600.00',gross_earnings:'6700.00',net_payable:'6400.00'}],available_employees:[{id:'e1',employee_number:'001',display_name:'Ali',is_active:true}]});}));
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
 const data={draft:{id:'d1',period_month:'2026-11-01',currency_code:'SAR',version:1,status:'draft',approved_at:null,approved_by_email:null,gross_earnings:'1123.47',employee_deductions:'0.02',employer_contributions:'0.03',net_payable:'1123.45'},employees:[{id:'x1',employee_id:'e1',employee_number:'001',display_name:'Ali',version:1,salary:'1000.01',allowances:'123.45',legacy_allowances:'123.45',housing_allowance:'0.00',transportation_allowance:'0.00',other_allowance:'0.00',bonus:'0.01',overtime:'0.00',deductions:'0.02',employer_contributions:'0.03',gross_earnings:'1123.47',net_payable:'1123.45'}],available_employees:[{id:'e1',employee_number:'001',display_name:'Ali',is_active:true}]};
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

it('shows approval confirmation, then locks the approved payroll in English and Arabic',async()=>{
 const {fireEvent}=await import('@testing-library/react');
 const {default:i18n}=await import('../i18n');
 const original=i18n.language;
 await i18n.changeLanguage('en');
 const draft={id:'d1',period_month:'2026-11-01',currency_code:'SAR',version:2,status:'draft',approved_at:null,approved_by_email:null,gross_earnings:'100.00',employee_deductions:'10.00',employer_contributions:'5.00',net_payable:'90.00'};
 const approved={...draft,version:3,status:'approved',approved_at:'2026-11-11T12:00:00.000Z',approved_by_email:'approver@example.test'};
 const line={id:'x1',employee_id:'e1',employee_number:'001',display_name:'Ali',version:1,salary:'100.00',allowances:'0.00',legacy_allowances:'0.00',housing_allowance:'0.00',transportation_allowance:'0.00',other_allowance:'0.00',bonus:'0.00',overtime:'0.00',deductions:'10.00',employer_contributions:'5.00',gross_earnings:'100.00',net_payable:'90.00'};
 const sent:unknown[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url:string,options?:RequestInit)=>{if(options?.method==='POST'){sent.push(JSON.parse(String(options.body)));return response({draft:approved,employees:[line],available_employees:[]});}return response({draft,employees:[line],available_employees:[]});}));
 try{
  render(<MonthlyPayroll capabilities={['payroll.view','payroll.edit','payroll.approve']} onUnauthorized={()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Approve payroll'}));
  expect(screen.getByRole('dialog')).toHaveTextContent('lock');
  expect(sent).toHaveLength(0);
  fireEvent.click(screen.getByRole('dialog').querySelector('button.primary')!);
  await screen.findByText(/Approved · Read only/);
  expect(sent).toEqual([{version:2}]);
  expect(screen.getByText('approver@example.test')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Edit'})).toBeNull();
  await i18n.changeLanguage('ar');
  expect(screen.getByText(/معتمد · للقراءة فقط/)).toBeInTheDocument();
 }finally{await i18n.changeLanguage(original);}
});

it('shows read-only mapped preview, blockers and manual-journal warning in English and Arabic with responsive RTL styles',async()=>{
 const {default:i18n}=await import('../i18n');const original=i18n.language;await i18n.changeLanguage('en');
 const draft={id:'d1',period_month:'2026-03-01',currency_code:'SAR',version:3,status:'approved',approved_at:'2026-03-31T12:00:00.000Z',approved_by_email:'approver@example.test',gross_earnings:'101.00',employee_deductions:'0.50',employer_contributions:'0.60',net_payable:'100.50'};
 const mapping={mapping_key:'earnings_expense',account_id:'a1',account_code:'5000',account_name:'Salaries',account_name_ar:'رواتب',account_type:'expense',account_active:true};
 const preview={totals:{earnings:'101.00',employee_deductions:'0.50',net_payable:'100.50',employer_contributions:'0.60',debit_total:'101.60',credit_total:'101.60'},mappings:[{mapping_key:'earnings_expense',account_id:'a1',code:'5000',name:'Salaries',name_ar:'رواتب',account_type:'expense',is_active:true}],lines:[{mapping_key:'earnings_expense',account_id:'a1',debit:'101.00',credit:'0.00'}],blockers:[{code:'ecc_overlap',count:1,details:[{employee_number:'001',display_name:'Ali',category:'salary',amount:'100.00'}]}],warnings:[{code:'manual_journal_review',count:1}],balanced:true,can_preview:false,side_effects:false};
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url==='/api/payroll/account-mappings'?response({mappings:[mapping],accounts:[{id:'a1',code:'5000',name:'Salaries',name_ar:'رواتب',account_type:'expense',is_active:true}],requirements:[]}):url.endsWith('/accounting-preview')?response(preview):response({draft,employees:[],available_employees:[]})));
 try{
  render(<MonthlyPayroll capabilities={['payroll.view','payroll.accounting.mapping.view','payroll.accounting.mapping.manage','payroll.accounting.preview']} onUnauthorized={()=>{}}/>);
  expect(await screen.findByText('Read-only journal preview')).toBeInTheDocument();
  expect(screen.getByText(/Approved Employee Cost Center allocations overlap/)).toBeInTheDocument();
  expect(screen.getByText(/Source-less journals exist in this month/)).toBeInTheDocument();
  expect(screen.getAllByRole('option',{name:/5000.*Salaries/}).length).toBeGreaterThan(0);
  expect(screen.getByText(/Preview only; no journal or ledger changes were made/)).toBeInTheDocument();
  await act(async()=>{await i18n.changeLanguage('ar');});
  expect(screen.getByText('معاينة قيد للقراءة فقط')).toBeInTheDocument();
  expect(screen.getByText(/تتداخل تخصيصات معتمدة من مركز تكاليف الموظفين/)).toBeInTheDocument();
  expect(screen.getAllByRole('option',{name:/5000.*رواتب/}).length).toBeGreaterThan(0);
  const css=readFileSync(resolve(__dirname,'../components/MonthlyPayroll.css'),'utf8');
  expect(css).toContain('@media(max-width:48em)');
  expect(css).toContain('margin-inline-start');
  expect(css).toContain('grid-template-columns:1fr');
 }finally{await i18n.changeLanguage(original);}
});
