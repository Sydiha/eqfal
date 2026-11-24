import { fireEvent,render,screen,waitFor,within } from '@testing-library/react';
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
  render(<EmployeeSalaryAdvances capabilities={['employee.view','employee_salary_advance.view','employee_salary_advance.create']} onUnauthorized={vi.fn()} createOpen onCreateClose={vi.fn()}/>);
  fireEvent.change(await screen.findByRole('combobox'),{target:{value:'emp-1'}});
  fireEvent.change(screen.getByLabelText(/Amount/),{target:{value:'125.50'}});
  fireEvent.change(screen.getByLabelText(/Description/),{target:{value:'Travel season advance'}});
  fireEvent.click(screen.getByRole('button',{name:/Save draft/}));
  await waitFor(()=>expect(calls.some(c=>c.method==='POST')).toBe(true));
  expect(calls.find(c=>c.method==='POST')).toMatchObject({url:'/api/employee-salary-advances',body:{employee_id:'emp-1',amount:'125.50',description:'Travel season advance'}});
 });
 it('lists the register before configuration and keeps balances and technical ids out of the register',async()=>{
  const uuid='cd7996e5-7887-4663-b781-14f9436faebb';
  const row={id:'a1',employee_id:'emp-1',employee_number:'E1',display_name:'Example',amount:'1000.00',currency_code:'SAR',issue_date:'2026-11-16',description:'Season advance',status:'issued',version:1,outstanding_amount:'900.00',recovered_amount:'1100.00',reversed_amount:'100.00',reserved_amount:'0.00',available_amount:'900.00',bank_transaction_id:uuid,journal_reference:'EA 5c567909'};
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({advances:[row],mapping:{account_id:'acc',code:'1250'},mapping_configured:true,employees:[{id:'emp-1',employee_number:'E1',display_name:'Example'}],accounts:[],bank_transactions:[]}),{status:200})));
  render(<EmployeeSalaryAdvances capabilities={['employee.view','employee_salary_advance.view','employee_salary_advance.create','employee_salary_advance.mapping.manage']} onUnauthorized={vi.fn()}/>);
  const table=await screen.findByRole('table');
  expect(within(table).getAllByRole('columnheader')).toHaveLength(6);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Amount/)).not.toBeInTheDocument();
  const register=table.compareDocumentPosition(screen.getByText('Employee advance receivable account'));
  expect(register&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(table).queryByText(/1100\.00/)).not.toBeInTheDocument();
  expect(screen.getByText('1,100.00 SAR')).toBeInTheDocument();
  expect(screen.queryByText(uuid)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain(uuid);
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
