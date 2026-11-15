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
  render(<EmployeeSalaryAdvances capabilities={['employee_salary_advance.view','employee_salary_advance.create']} onUnauthorized={vi.fn()}/>);
  fireEvent.change(await screen.findByRole('combobox'),{target:{value:'emp-1'}});
  fireEvent.change(screen.getByLabelText(/Amount/),{target:{value:'125.50'}});
  fireEvent.change(screen.getByLabelText(/Description/),{target:{value:'Travel season advance'}});
  fireEvent.click(screen.getByRole('button',{name:/Save draft/}));
  await waitFor(()=>expect(calls.some(c=>c.method==='POST')).toBe(true));
  expect(calls.find(c=>c.method==='POST')).toMatchObject({url:'/api/employee-salary-advances',body:{employee_id:'emp-1',amount:'125.50',description:'Travel season advance'}});
 });
});
