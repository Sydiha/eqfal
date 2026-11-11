import { Router, Request, Response, NextFunction } from 'express';
import pool from '../../db/pool';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { requireAuth, requireActiveCompany, requireCapability, getAuthenticatedContext } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';

export const payrollRouter=Router();
const month=/^\d{4}-(0[1-9]|1[0-2])-01$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const money=/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const fields=['salary','housing_allowance','transportation_allowance','other_allowance','bonus','overtime','deductions','employer_contributions'] as const;
const storedFields=['salary','allowances','legacy_allowances','housing_allowance','transportation_allowance','other_allowance','bonus','overtime','deductions','employer_contributions'] as const;
const cents=(v:string)=>{const [a,f='']=v.split('.');return BigInt(a)*100n+BigInt(f.padEnd(2,'0'));};
const decimal=(value:bigint)=>`${value/100n}.${String(value%100n).padStart(2,'0')}`;
const maxMoney=9999999999999999n;
const read=[requireAuth,requireActiveCompany,requireCapability('payroll.view')];
const write=[requireSameOrigin,...read,requireCapability('payroll.edit')];
const route=(fn:(q:Request,s:Response)=>Promise<void>)=>(q:Request,s:Response,n:NextFunction)=>void fn(q,s).catch(n);
const company=(q:Request)=>getAuthenticatedContext(q)!.activeCompanyId!;
const audit=new AuditLogRepository();
const error=(s:Response,code:string,status=400)=>s.status(status).json({code,error:code});
const validMonth=(v:unknown):v is string=>typeof v==='string'&&month.test(v)&&!Number.isNaN(Date.parse(v));
const summary=`SELECT d.id,d.period_month::text,d.currency_code,d.version,d.created_at::text,d.updated_at::text,
 COALESCE(SUM(e.salary+e.allowances+e.bonus+e.overtime),0)::text gross_earnings,
 COALESCE(SUM(e.deductions),0)::text employee_deductions,
 COALESCE(SUM(e.employer_contributions),0)::text employer_contributions,
 COALESCE(SUM(e.salary+e.allowances+e.bonus+e.overtime-e.deductions),0)::text net_payable
 FROM payroll_drafts d LEFT JOIN payroll_draft_employees e ON e.draft_id=d.id AND e.company_id=d.company_id
 WHERE d.company_id=$1 AND d.period_month=$2 GROUP BY d.id`;
async function detail(q:Request,s:Response,period:string){
 const draft=(await pool!.query(summary,[company(q),period])).rows[0]??null;
 const available_employees=(await pool!.query('SELECT id,employee_number,display_name,is_active FROM employees WHERE company_id=$1 ORDER BY employee_number,id',[company(q)])).rows;
 if(!draft){s.json({draft:null,employees:[],available_employees});return;}
 const employees=(await pool!.query(`SELECT p.id,p.employee_id,e.employee_number,e.display_name,p.version,p.salary::text,p.allowances::text,COALESCE(p.legacy_allowances,p.allowances)::text legacy_allowances,p.housing_allowance::text,p.transportation_allowance::text,p.other_allowance::text,p.bonus::text,p.overtime::text,p.deductions::text,p.employer_contributions::text,
 (p.salary+p.allowances+p.bonus+p.overtime)::text gross_earnings,(p.salary+p.allowances+p.bonus+p.overtime-p.deductions)::text net_payable
 FROM payroll_draft_employees p JOIN employees e ON e.id=p.employee_id AND e.company_id=p.company_id WHERE p.company_id=$1 AND p.draft_id=$2 ORDER BY e.employee_number,e.id`,[company(q),draft.id])).rows;
 s.json({draft,employees,available_employees});
}
payrollRouter.get('/payroll/drafts',...read,route(async(q,s)=>{if(!validMonth(q.query.month))return void error(s,'PAYROLL_INVALID');await detail(q,s,q.query.month);}));
payrollRouter.post('/payroll/drafts',...write,route(async(q,s)=>{
 if(!q.body||Object.keys(q.body).sort().join(',')!=='month'||!validMonth(q.body.month))return void error(s,'PAYROLL_INVALID');
 const c=await pool!.connect();try{await c.query('BEGIN');const created=(await c.query<{id:string}>('INSERT INTO payroll_drafts(company_id,period_month,created_by) VALUES($1,$2,$3) RETURNING id',[company(q),q.body.month,getAuthenticatedContext(q)!.user.id])).rows[0]!;await audit.logEvent({company_id:company(q),actor_user_id:getAuthenticatedContext(q)!.user.id,action:'payroll.draft.create',entity_type:'payroll_draft',entity_id:created.id,after_data:{period_month:q.body.month}},c);await c.query('COMMIT');}
 catch(e){await c.query('ROLLBACK');if((e as {code?:string}).code==='23505')return void error(s,'PAYROLL_PERIOD_EXISTS',409);throw e;}finally{c.release();}
 s.status(201);await detail(q,s,q.body.month);
}));
payrollRouter.put('/payroll/drafts/:id/employees/:employeeId',...write,route(async(q,s)=>{
 const b=q.body;if(!uuid.test(q.params.id)||!uuid.test(q.params.employeeId)||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!==[...fields,'version'].sort().join(',')||!Number.isInteger(b.version)||b.version<0||fields.some(f=>typeof b[f]!=='string'||!money.test(b[f])))return void error(s,'PAYROLL_INVALID');
 if(fields.some(f=>cents(b[f])>maxMoney))return void error(s,'PAYROLL_INVALID');
 const c=await pool!.connect();try{
  await c.query('BEGIN');
  const draft=(await c.query('SELECT period_month::text FROM payroll_drafts WHERE id=$1 AND company_id=$2 FOR UPDATE',[q.params.id,company(q)])).rows[0];
  if(!draft){await c.query('ROLLBACK');return void error(s,'PAYROLL_NOT_FOUND',404);}
  const employee=(await c.query('SELECT id FROM employees WHERE id=$1 AND company_id=$2 FOR SHARE',[q.params.employeeId,company(q)])).rows[0];
  if(!employee){await c.query('ROLLBACK');return void error(s,'PAYROLL_NOT_FOUND',404);}
  const prior=(await c.query('SELECT version,salary::text,allowances::text,legacy_allowances::text,housing_allowance::text,transportation_allowance::text,other_allowance::text,bonus::text,overtime::text,deductions::text,employer_contributions::text FROM payroll_draft_employees WHERE draft_id=$1 AND company_id=$2 AND employee_id=$3 FOR UPDATE',[q.params.id,company(q),q.params.employeeId])).rows[0];
  if((prior?.version??0)!==b.version){await c.query('ROLLBACK');return void error(s,'PAYROLL_CONFLICT',409);}
  const legacy=prior?cents(prior.legacy_allowances??prior.allowances):0n;
  const allowances=legacy+cents(b.housing_allowance)+cents(b.transportation_allowance)+cents(b.other_allowance);
  const gross=cents(b.salary)+allowances+cents(b.bonus)+cents(b.overtime);
  if(allowances>maxMoney||gross<cents(b.deductions)){await c.query('ROLLBACK');return void error(s,'PAYROLL_INVALID');}
  const stored={...b,allowances:decimal(allowances),legacy_allowances:decimal(legacy)};
  await c.query(`INSERT INTO payroll_draft_employees(company_id,draft_id,employee_id,salary,allowances,legacy_allowances,housing_allowance,transportation_allowance,other_allowance,bonus,overtime,deductions,employer_contributions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(company_id,draft_id,employee_id) DO UPDATE SET salary=$4,allowances=$5,legacy_allowances=$6,housing_allowance=$7,transportation_allowance=$8,other_allowance=$9,bonus=$10,overtime=$11,deductions=$12,employer_contributions=$13,version=payroll_draft_employees.version+1,updated_at=NOW()`,[company(q),q.params.id,q.params.employeeId,...storedFields.map(f=>stored[f])]);
  await c.query('UPDATE payroll_drafts SET version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2',[q.params.id,company(q)]);
  await audit.logEvent({company_id:company(q),actor_user_id:getAuthenticatedContext(q)!.user.id,action:prior?'payroll.draft_employee.update':'payroll.draft_employee.create',entity_type:'payroll_draft_employee',entity_id:q.params.employeeId,before_data:prior?Object.fromEntries(storedFields.map(f=>[f,prior[f]])):null,after_data:{draft_id:q.params.id,employee_id:q.params.employeeId,version:(prior?.version??0)+1,...Object.fromEntries(storedFields.map(f=>[f,stored[f]]))}},c);
  await c.query('COMMIT');await detail(q,s,draft.period_month);
 }catch(e){await c.query('ROLLBACK');if((e as {code?:string}).code==='23514')return void error(s,'PAYROLL_INVALID');throw e;}finally{c.release();}
}));
