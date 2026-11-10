import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { AllocationInput, CostInput, EmployeeCostError, EmployeeCostService, EMPLOYEE_COST_CATEGORIES, EMPLOYEE_COST_NATURES, isDate } from './employee-cost.service';

export const employeeCostRouter = Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY=/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const only=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
const asyncRoute=(h:(q:Request,s:Response,n:NextFunction)=>Promise<void>):RequestHandler=>(q,s,n)=>void h(q,s,n).catch(n);
class Invalid extends Error {}
const bad=()=>new Invalid();
function ctx(q:Request){return getAuthenticatedContext(q)! as NonNullable<ReturnType<typeof getAuthenticatedContext>>&{activeCompanyId:string};}
function service(s:Response){if(!pool){s.status(503).json({error:'Database unavailable',code:'DB_UNAVAILABLE'});return null;}return new EmployeeCostService(pool);}
function handle(e:unknown,s:Response){if(e instanceof EmployeeCostError){s.status(e.status).json({error:e.message,code:e.code});return true;}if(e instanceof Invalid){s.status(400).json({error:'Invalid employee cost request',code:'EMPLOYEE_COST_INVALID'});return true;}return false;}
const route=(fn:(v:EmployeeCostService,q:Request,s:Response)=>Promise<void>):RequestHandler=>asyncRoute(async(q,s)=>{const v=service(s);if(!v)return;try{await fn(v,q,s);}catch(e){if(!handle(e,s))throw e;}});
const readEmployee=[requireAuth,requireActiveCompany,requireCapability('employee.view')];
const readCosts=[requireAuth,requireActiveCompany,requireCapability('employee.view'),requireCapability('employee_cost.view')];
const write=[requireSameOrigin,requireAuth,requireActiveCompany];
const requireAll=(...caps:string[]):RequestHandler=>(q,s,n)=>{const auth=getAuthenticatedContext(q);if(!auth||!auth.activeCompanyId||caps.some(x=>!auth.capabilities.includes(x))){s.status(403).json({error:'Forbidden'});return;}n();};
function id(v:unknown){if(typeof v!=='string'||!UUID.test(v))throw bad();return v;}
function text(v:unknown,max:number){if(typeof v!=='string'||!v.trim()||v.trim().length>max)throw bad();return v.trim();}
function nullableDate(v:unknown){if(v===null||v==='')return null;if(!isDate(v))throw bad();return v;}
function version(v:unknown){if(typeof v!=='number'||!Number.isInteger(v)||v<1)throw bad();return v;}
function parseEmployee(v:unknown){if(!plain(v)||!only(v,['employee_number','display_name','employment_start','employment_end']))throw bad();const start=nullableDate(v.employment_start),end=nullableDate(v.employment_end);if(end&&(!start||end<start))throw bad();return{employee_number:text(v.employee_number,50),display_name:text(v.display_name,200),employment_start:start,employment_end:end};}
function parseCost(v:unknown):CostInput{
  if(!plain(v)||!only(v,['category','nature','currency_code','total_amount','service_period_start','service_period_end','description','allocations']))throw bad();
  if(typeof v.category!=='string'||!(EMPLOYEE_COST_CATEGORIES as readonly string[]).includes(v.category)||typeof v.nature!=='string'||!(EMPLOYEE_COST_NATURES as readonly string[]).includes(v.nature))throw bad();
  const amount=typeof v.total_amount==='number'?String(v.total_amount):v.total_amount;
  if(typeof amount!=='string'||!MONEY.test(amount)||typeof v.currency_code!=='string'||!/^([A-Z]{3})$/.test(v.currency_code)||!isDate(v.service_period_start)||!isDate(v.service_period_end)||typeof v.description!=='string'||!Array.isArray(v.allocations))throw bad();
  const allocations:AllocationInput[]=v.allocations.map((x:unknown)=>{if(!plain(x)||!only(x,['fiscal_year_id','allocation_month','amount']))throw bad();const a=typeof x.amount==='number'?String(x.amount):x.amount;if(typeof x.fiscal_year_id!=='string'||!UUID.test(x.fiscal_year_id)||!isDate(x.allocation_month)||typeof a!=='string'||!MONEY.test(a))throw bad();return{fiscal_year_id:x.fiscal_year_id,allocation_month:x.allocation_month,amount:a};});
  return{category:v.category as CostInput['category'],nature:v.nature as CostInput['nature'],currency_code:v.currency_code,total_amount:amount,service_period_start:v.service_period_start,service_period_end:v.service_period_end,description:text(v.description,500),allocations};
}
function salaryVisible(q:Request){return ctx(q).capabilities.includes('employee_cost.salary.view');}
function requireSalaryVisibility(q:Request,v:CostInput){if(v.nature!=='employer_cost'&&!salaryVisible(q))throw new EmployeeCostError(403,'FORBIDDEN','Forbidden');}

employeeCostRouter.get('/employees',...readEmployee,route(async(v,q,s)=>{s.json(await v.employees(ctx(q).activeCompanyId));}));
employeeCostRouter.post('/employees',...write,requireCapability('employee.manage'),route(async(v,q,s)=>{s.status(201).json(await v.createEmployee(ctx(q).activeCompanyId,ctx(q).user.id,parseEmployee(q.body)));}));
employeeCostRouter.patch('/employees/:id',...write,requireCapability('employee.manage'),route(async(v,q,s)=>{if(!plain(q.body)||!only(q.body,['employee_number','display_name','employment_start','employment_end','is_active','version'])||typeof q.body.is_active!=='boolean')throw bad();const patch=parseEmployee({employee_number:q.body.employee_number,display_name:q.body.display_name,employment_start:q.body.employment_start,employment_end:q.body.employment_end});s.json(await v.updateEmployee(ctx(q).activeCompanyId,ctx(q).user.id,id(q.params.id),version(q.body.version),{...patch,is_active:q.body.is_active}));}));

employeeCostRouter.get('/employee-costs/fiscal-years',...readCosts,route(async(v,q,s)=>{s.json(await v.fiscalYears(ctx(q).activeCompanyId));}));
employeeCostRouter.get('/employee-costs/reports/monthly',...readCosts,route(async(v,q,s)=>{if(typeof q.query.month!=='string'||!isDate(q.query.month)||q.query.month.slice(-2)!=='01'||typeof q.query.fiscal_year_id!=='string')throw bad();s.json(await v.report(ctx(q).activeCompanyId,id(q.query.fiscal_year_id),q.query.month,salaryVisible(q)));}));
employeeCostRouter.get('/employee-costs/reports/annual',...readCosts,route(async(v,q,s)=>{if(typeof q.query.fiscal_year_id!=='string')throw bad();s.json(await v.report(ctx(q).activeCompanyId,id(q.query.fiscal_year_id),null,salaryVisible(q)));}));
employeeCostRouter.get('/employee-costs',...readCosts,route(async(v,q,s)=>{s.json(await v.listCosts(ctx(q).activeCompanyId,salaryVisible(q)));}));
employeeCostRouter.get('/employee-costs/:id/history',...readCosts,route(async(v,q,s)=>{s.json(await v.history(ctx(q).activeCompanyId,id(q.params.id),salaryVisible(q)));}));
employeeCostRouter.post('/employee-costs',...write,requireAll('employee.view','employee_cost.create'),route(async(v,q,s)=>{if(!plain(q.body)||!only(q.body,['employee_id','record','version'])||q.body.version!==undefined)throw bad();const record=parseCost(q.body.record);requireSalaryVisibility(q,record);s.status(201).json(await v.createCost(ctx(q).activeCompanyId,ctx(q).user.id,id(q.body.employee_id),record));}));
employeeCostRouter.patch('/employee-costs/:id',...write,requireAll('employee.view','employee_cost.create'),route(async(v,q,s)=>{if(!plain(q.body)||!only(q.body,['record','version']))throw bad();const record=parseCost(q.body.record);requireSalaryVisibility(q,record);s.json(await v.updateDraftCost(ctx(q).activeCompanyId,ctx(q).user.id,id(q.params.id),version(q.body.version),record,salaryVisible(q)));}));
employeeCostRouter.post('/employee-costs/:id/approve',...write,requireAll('employee.view','employee_cost.approve'),route(async(v,q,s)=>{if(!plain(q.body)||!only(q.body,['version']))throw bad();s.json({record:await v.approveCost(ctx(q).activeCompanyId,ctx(q).user.id,id(q.params.id),version(q.body.version),salaryVisible(q))});}));
employeeCostRouter.post('/employee-costs/:id/corrections',...write,requireAll('employee.view','employee_cost.correct','employee_cost.approve'),route(async(v,q,s)=>{if(!plain(q.body)||!only(q.body,['reason','record']))throw bad();const record=parseCost(q.body.record);requireSalaryVisibility(q,record);s.status(201).json(await v.correctCost(ctx(q).activeCompanyId,ctx(q).user.id,id(q.params.id),text(q.body.reason,500),record,salaryVisible(q)));}));
