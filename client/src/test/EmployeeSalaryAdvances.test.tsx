import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import { EmployeeSalaryAdvances } from '../components/EmployeeSalaryAdvances';
import i18n from '../i18n';

describe('employee salary advances UI',()=>{
 beforeEach(async()=>{await i18n.changeLanguage('en');});
 it('hides the workflow without view permission',()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  const {container}=render(<EmployeeSalaryAdvances capabilities={[]} onUnauthorized={vi.fn()}/>);
  expect(container).toBeEmptyDOMElement();expect(fetcher).not.toHaveBeenCalled();
 });
 it('creates an employee linked draft using the advance API',async()=>{
  const calls:Array<{url:string;method:string;body:unknown}>=[];
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,options?:RequestInit)=>{
   const url=String(input),method=options?.method??'GET';
   calls.push({url,method,body:options?.body?JSON.parse(String(options.body)):null});
   if(url==='/api/employee-salary-advances'&&method==='GET')return new Response(JSON.stringify({advances:[],mapping:null,employees:[{id:'emp-1',employee_number:'E1',display_name:'Example'}],accounts:[],bank_transactions:[]}),{status:200});
   if(url==='/api/employee-salary-advances'&&method==='POST')return new Response(JSON.stringify({advance:{id:'a1'}}),{status:201});
   return new Response('{}',{status:200});
  }));
  render(<EmployeeSalaryAdvances capabilities={['employee.view','employee_salary_advance.view','employee_salary_advance.create']} onUnauthorized={vi.fn()}/>);
  fireEvent.change(await screen.findByRole('combobox'),{target:{value:'emp-1'}});
  fireEvent.change(screen.getByLabelText(/Amount/),{target:{value:'125.50'}});
  fireEvent.change(screen.getByLabelText(/Description/),{target:{value:'Travel season advance'}});
  fireEvent.click(screen.getByRole('button',{name:/Save draft/}));
  await waitFor(()=>expect(calls.some(c=>c.method==='POST')).toBe(true));
  expect(calls.find(c=>c.method==='POST')).toMatchObject({url:'/api/employee-salary-advances',body:{employee_id:'emp-1',amount:'125.50',description:'Travel season advance'}});
 });
 it('shows cancellation recovery only to users with bank and cancellation permissions',async()=>{
  const row={id:'a-pending',employee_id:'emp-1',employee_number:'E1',display_name:'Example',amount:'125.50',currency_code:'SAR',issue_date:'2026-03-10',description:'Recovery case',status:'pending_posting',version:3,outstanding_amount:'0.00',bank_transaction_id:'tx-1',journal_reference:null};
  const calls:Array<{url:string;method:string;body:unknown}>=[];
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,options?:RequestInit)=>{
   const url=String(input),method=options?.method??'GET';calls.push({url,method,body:options?.body?JSON.parse(String(options.body)):null});
   if(method==='GET')return new Response(JSON.stringify({advances:[row],mapping:null,employees:[],accounts:[],bank_transactions:[]}),{status:200});
   return new Response(JSON.stringify({status:'approved',version:4}),{status:200});
  }));
  const first=render(<EmployeeSalaryAdvances capabilities={['employee.view','employee_salary_advance.view','employee_salary_advance.cancel']} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByText('Pending journal posting')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Cancel pending issuance'})).not.toBeInTheDocument();
  first.unmount();
  render(<EmployeeSalaryAdvances capabilities={['employee.view','employee_salary_advance.view','employee_salary_advance.cancel','bank.view']} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByRole('button',{name:'Cancel pending issuance'})).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Cancellation reason'),{target:{value:'Wrong bank transaction selected'}});
  fireEvent.click(screen.getByRole('button',{name:'Cancel pending issuance'}));
  await waitFor(()=>expect(calls.some(c=>c.method==='POST')).toBe(true));
  expect(calls.find(c=>c.method==='POST')).toMatchObject({url:'/api/employee-salary-advances/a-pending/cancel-pending',body:{version:3,reason:'Wrong bank transaction selected'}});
 });
});
