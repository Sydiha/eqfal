import { Router, Request, Response, NextFunction } from 'express';
import pool from '../../db/pool';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { requireAuth, requireActiveCompany, requireCapability, getAuthenticatedContext } from '../auth/auth.middleware';
import { PAYROLL_SETTLEMENT_EXCEPTION_APPROVER_CAPABILITY } from '../memberships/authorization-policy';
import { requireSameOrigin } from '../auth/origin.middleware';
import { PayrollAccountingError, PayrollAccountingService, PAYROLL_ACCOUNT_MAPPINGS, PayrollMappingKey } from './payroll-accounting';
import { PayrollSettlementError, PayrollSettlementService } from './payroll-settlement';
import { hasPrivilegedFinancialAuthority } from '../memberships/privileged-financial-authority';
import { assertAccountingDateWritable } from '../monthly-close/accounting-period.guard';
import { PayrollRecoveryCorrectionError,PayrollRecoveryCorrectionService } from './payroll-recovery-correction';

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
const approve=[requireSameOrigin,...read,requireCapability('payroll.approve')];
const requirePostingStatusRead=(q:Request,s:Response,n:NextFunction)=>{
 const capabilities=getAuthenticatedContext(q)!.capabilities;
 if(capabilities.includes('payroll.accounting.preview')||capabilities.includes('payroll.accounting.post'))return n();
 s.status(403).json({code:'FORBIDDEN',error:'Forbidden'});
};
const route=(fn:(q:Request,s:Response)=>Promise<void>)=>(q:Request,s:Response,n:NextFunction)=>void fn(q,s).catch(n);
const company=(q:Request)=>getAuthenticatedContext(q)!.activeCompanyId!;
const audit=new AuditLogRepository();
const error=(s:Response,code:string,status=400)=>s.status(status).json({code,error:code});
const validMonth=(v:unknown):v is string=>typeof v==='string'&&month.test(v)&&!Number.isNaN(Date.parse(v));
const summary=`SELECT d.id,d.period_month::text,d.currency_code,d.version,d.status,d.approved_at::text,
 u.email approved_by_email,d.created_at::text,d.updated_at::text,
 COALESCE(SUM(e.salary+e.allowances+e.bonus+e.overtime),0)::text gross_earnings,
 COALESCE(SUM(e.deductions),0)::text employee_deductions,
 COALESCE(SUM(e.employer_contributions),0)::text employer_contributions,
 COALESCE(SUM(e.salary+e.allowances+e.bonus+e.overtime-e.deductions-COALESCE((SELECT sum(r.amount) FROM payroll_employee_advance_recoveries r WHERE r.company_id=e.company_id AND r.draft_id=e.draft_id AND r.employee_id=e.employee_id AND r.status IN('selected','reserved','posted')),0)),0)::text net_payable
 FROM payroll_drafts d LEFT JOIN payroll_draft_employees e ON e.draft_id=d.id AND e.company_id=d.company_id
 LEFT JOIN users u ON u.id=d.approved_by
 WHERE d.company_id=$1 AND d.period_month=$2 GROUP BY d.id,u.email`;
async function detail(q:Request,s:Response,period:string){
 const eligibility=(await pool!.query<{eligible:boolean}>(`SELECT
   (SELECT count(*)=1 AND bool_and(f.status='open') FROM fiscal_years f WHERE f.company_id=$1 AND $2::date BETWEEN f.start_date AND f.end_date)
   AND NOT EXISTS(SELECT 1 FROM monthly_close_periods m WHERE m.company_id=$1 AND m.status='closed' AND $2::date BETWEEN m.period_start AND m.period_end)
   AND NOT EXISTS(SELECT 1 FROM ledger_source_authority a WHERE a.company_id=$1 AND a.status='active' AND $2::date BETWEEN a.from_date AND a.to_date) eligible`,[company(q),period])).rows[0]!.eligible;
 const draft=(await pool!.query(summary,[company(q),period])).rows[0]??null;
 const available_employees=(await pool!.query('SELECT id,employee_number,display_name,is_active FROM employees WHERE company_id=$1 ORDER BY employee_number,id',[company(q)])).rows;
 if(!draft){s.json({draft:null,employees:[],available_employees,period_eligibility:{eligible:eligibility}});return;}
 let employees=(await pool!.query(`SELECT p.id,p.employee_id,e.employee_number,e.display_name,p.version,p.salary::text,p.allowances::text,COALESCE(p.legacy_allowances,p.allowances)::text legacy_allowances,p.housing_allowance::text,p.transportation_allowance::text,p.other_allowance::text,p.bonus::text,p.overtime::text,p.deductions::text,p.employer_contributions::text,
 (p.salary+p.allowances+p.bonus+p.overtime)::text gross_earnings,COALESCE((SELECT sum(r.amount) FROM payroll_employee_advance_recoveries r WHERE r.company_id=p.company_id AND r.draft_id=p.draft_id AND r.employee_id=p.employee_id AND r.status IN('selected','reserved','posted')),0)::text recovery_total,
 (p.salary+p.allowances+p.bonus+p.overtime-p.deductions-COALESCE((SELECT sum(r.amount) FROM payroll_employee_advance_recoveries r WHERE r.company_id=p.company_id AND r.draft_id=p.draft_id AND r.employee_id=p.employee_id AND r.status IN('selected','reserved','posted')),0))::text net_payable
 FROM payroll_draft_employees p JOIN employees e ON e.id=p.employee_id AND e.company_id=p.company_id WHERE p.company_id=$1 AND p.draft_id=$2 ORDER BY e.employee_number,e.id`,[company(q),draft.id])).rows;
 if(getAuthenticatedContext(q)!.capabilities.includes('payroll.employee_advance_recovery.view')){
  const recoveries=(await pool!.query(`SELECT employee_id,advance_id,amount::text,status,expires_at::text FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND draft_id=$2 AND status IN('selected','reserved','posted') ORDER BY employee_id,advance_id`,[company(q),draft.id])).rows;
  employees=employees.map((line:any)=>({...line,recoveries:recoveries.filter((r:any)=>r.employee_id===line.employee_id)}));
 }
 s.json({draft,employees,available_employees,period_eligibility:{eligible:eligibility}});
}
payrollRouter.get('/payroll/drafts',...read,route(async(q,s)=>{if(!validMonth(q.query.month))return void error(s,'PAYROLL_INVALID');await detail(q,s,q.query.month);}));
payrollRouter.post('/payroll/drafts',...write,route(async(q,s)=>{
 if(!q.body||Object.keys(q.body).sort().join(',')!=='month'||!validMonth(q.body.month))return void error(s,'PAYROLL_INVALID');
 const c=await pool!.connect();try{await c.query('BEGIN');const created=(await c.query<{id:string}>('INSERT INTO payroll_drafts(company_id,period_month,created_by) VALUES($1,$2,$3) RETURNING id',[company(q),q.body.month,getAuthenticatedContext(q)!.user.id])).rows[0]!;await c.query('INSERT INTO payroll_draft_contributors(company_id,draft_id,user_id) VALUES($1,$2,$3)',[company(q),created.id,getAuthenticatedContext(q)!.user.id]);await audit.logEvent({company_id:company(q),actor_user_id:getAuthenticatedContext(q)!.user.id,action:'payroll.draft.create',entity_type:'payroll_draft',entity_id:created.id,after_data:{period_month:q.body.month}},c);await c.query('COMMIT');}
 catch(e){await c.query('ROLLBACK');if((e as {code?:string}).code==='23505')return void error(s,'PAYROLL_PERIOD_EXISTS',409);throw e;}finally{c.release();}
 s.status(201);await detail(q,s,q.body.month);
}));
payrollRouter.put('/payroll/drafts/:id/employees/:employeeId',...write,route(async(q,s)=>{
 const b=q.body;if(!uuid.test(q.params.id)||!uuid.test(q.params.employeeId)||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!==[...fields,'version'].sort().join(',')||!Number.isInteger(b.version)||b.version<0||fields.some(f=>typeof b[f]!=='string'||!money.test(b[f])))return void error(s,'PAYROLL_INVALID');
 if(fields.some(f=>cents(b[f])>maxMoney))return void error(s,'PAYROLL_INVALID');
 const c=await pool!.connect();try{
  await c.query('BEGIN');
  const draft=(await c.query('SELECT period_month::text,status FROM payroll_drafts WHERE id=$1 AND company_id=$2 FOR UPDATE',[q.params.id,company(q)])).rows[0];
  if(!draft){await c.query('ROLLBACK');return void error(s,'PAYROLL_NOT_FOUND',404);}
  if(draft.status!=='draft'){await c.query('ROLLBACK');return void error(s,'PAYROLL_ALREADY_APPROVED',409);}
  const employee=(await c.query('SELECT id FROM employees WHERE id=$1 AND company_id=$2 FOR SHARE',[q.params.employeeId,company(q)])).rows[0];
  if(!employee){await c.query('ROLLBACK');return void error(s,'PAYROLL_NOT_FOUND',404);}
  const prior=(await c.query('SELECT version,salary::text,allowances::text,legacy_allowances::text,housing_allowance::text,transportation_allowance::text,other_allowance::text,bonus::text,overtime::text,deductions::text,employer_contributions::text FROM payroll_draft_employees WHERE draft_id=$1 AND company_id=$2 AND employee_id=$3 FOR UPDATE',[q.params.id,company(q),q.params.employeeId])).rows[0];
  if((prior?.version??0)!==b.version){await c.query('ROLLBACK');return void error(s,'PAYROLL_CONFLICT',409);}
  const legacy=prior?cents(prior.legacy_allowances??prior.allowances):0n;
  const allowances=legacy+cents(b.housing_allowance)+cents(b.transportation_allowance)+cents(b.other_allowance);
  const gross=cents(b.salary)+allowances+cents(b.bonus)+cents(b.overtime);
  if(allowances>maxMoney||gross<cents(b.deductions)){await c.query('ROLLBACK');return void error(s,'PAYROLL_INVALID');}
  const linkedRecovery=(await c.query<{amount:string}>('SELECT COALESCE(sum(amount),0)::text amount FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND draft_id=$2 AND employee_id=$3 AND status=\'selected\'',[company(q),q.params.id,q.params.employeeId])).rows[0]!.amount;
  if(gross<cents(b.deductions)+cents(linkedRecovery)){await c.query('ROLLBACK');return void error(s,'PAYROLL_RECOVERY_EXCEEDS_NET',409);}
  const stored={...b,allowances:decimal(allowances),legacy_allowances:decimal(legacy)};
  await c.query(`INSERT INTO payroll_draft_employees(company_id,draft_id,employee_id,salary,allowances,legacy_allowances,housing_allowance,transportation_allowance,other_allowance,bonus,overtime,deductions,employer_contributions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(company_id,draft_id,employee_id) DO UPDATE SET salary=$4,allowances=$5,legacy_allowances=$6,housing_allowance=$7,transportation_allowance=$8,other_allowance=$9,bonus=$10,overtime=$11,deductions=$12,employer_contributions=$13,version=payroll_draft_employees.version+1,updated_at=NOW()`,[company(q),q.params.id,q.params.employeeId,...storedFields.map(f=>stored[f])]);
  await c.query('UPDATE payroll_drafts SET version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2',[q.params.id,company(q)]);
  await c.query('INSERT INTO payroll_draft_contributors(company_id,draft_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[company(q),q.params.id,getAuthenticatedContext(q)!.user.id]);
  await audit.logEvent({company_id:company(q),actor_user_id:getAuthenticatedContext(q)!.user.id,action:prior?'payroll.draft_employee.update':'payroll.draft_employee.create',entity_type:'payroll_draft_employee',entity_id:q.params.employeeId,before_data:prior?Object.fromEntries(storedFields.map(f=>[f,prior[f]])):null,after_data:{draft_id:q.params.id,employee_id:q.params.employeeId,version:(prior?.version??0)+1,...Object.fromEntries(storedFields.map(f=>[f,stored[f]]))}},c);
  await c.query('COMMIT');await detail(q,s,draft.period_month);
 }catch(e){await c.query('ROLLBACK');if((e as {code?:string}).code==='23514')return void error(s,'PAYROLL_INVALID');throw e;}finally{c.release();}
}));

// Selection is provisional while a draft is editable. Capacity is reserved only
// by the approval transaction below.
payrollRouter.put('/payroll/drafts/:id/employees/:employeeId/advance-recoveries',...write,requireCapability('payroll.employee_advance_recovery.select'),route(async(q,s)=>{
 const b=q.body;if(!uuid.test(q.params.id)||!uuid.test(q.params.employeeId)||!b||Object.keys(b).sort().join(',')!=='recoveries,version'||!Number.isInteger(b.version)||!Array.isArray(b.recoveries)||b.recoveries.some((x: any)=>!x||Object.keys(x).sort().join(',')!=='advance_id,amount'||!uuid.test(x.advance_id)||typeof x.amount!=='string'||!money.test(x.amount)||cents(x.amount)<=0n))return void error(s,'PAYROLL_INVALID');
 const c=await pool!.connect();try{await c.query('BEGIN');const d=(await c.query<{period_month:string;status:string}>('SELECT period_month::text,status FROM payroll_drafts WHERE id=$1 AND company_id=$2 FOR UPDATE',[q.params.id,company(q)])).rows[0];if(!d){await c.query('ROLLBACK');return void error(s,'PAYROLL_NOT_FOUND',404);}if(d.status!=='draft'){await c.query('ROLLBACK');return void error(s,'PAYROLL_ALREADY_APPROVED',409);}
 const line=(await c.query<{version:number;salary:string;allowances:string;bonus:string;overtime:string;deductions:string}>('SELECT version,salary::text,allowances::text,bonus::text,overtime::text,deductions::text FROM payroll_draft_employees WHERE company_id=$1 AND draft_id=$2 AND employee_id=$3 FOR UPDATE',[company(q),q.params.id,q.params.employeeId])).rows[0];if(!line||line.version!==b.version){await c.query('ROLLBACK');return void error(s,'PAYROLL_CONFLICT',409);}
 const ids=b.recoveries.map((x:any)=>x.advance_id);if(new Set(ids).size!==ids.length){await c.query('ROLLBACK');return void error(s,'PAYROLL_INVALID');}
 for(const x of b.recoveries){const a=(await c.query<{amount:string;employee_id:string;status:string}>('SELECT amount::text,employee_id,status FROM employee_salary_advances WHERE company_id=$1 AND id=$2 FOR UPDATE',[company(q),x.advance_id])).rows[0];if(!a||a.employee_id!==q.params.employeeId||a.status!=='issued'){await c.query('ROLLBACK');return void error(s,'PAYROLL_ADVANCE_INELIGIBLE',409);}const sums=(await c.query<{used:string}>('SELECT COALESCE(sum(amount) FILTER(WHERE status=\'posted\'),0)-COALESCE((SELECT sum(c.amount) FROM payroll_recovery_corrections c JOIN payroll_employee_advance_recoveries r ON r.id=c.recovery_id WHERE r.company_id=$1 AND r.advance_id=$2 AND c.status=\'posted\'),0) + COALESCE(sum(amount) FILTER(WHERE status=\'reserved\' AND expires_at>clock_timestamp()),0) used FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2',[company(q),x.advance_id])).rows[0]!;if(cents(sums.used)+cents(x.amount)>cents(a.amount)){await c.query('ROLLBACK');return void error(s,'PAYROLL_ADVANCE_BALANCE_EXCEEDED',409);}}
 await c.query("UPDATE payroll_employee_advance_recoveries SET status='released',ended_at=clock_timestamp(),end_reason='selection_replaced' WHERE company_id=$1 AND draft_id=$2 AND employee_id=$3 AND status='selected'",[company(q),q.params.id,q.params.employeeId]);
 for(const x of b.recoveries)await c.query("INSERT INTO payroll_employee_advance_recoveries(company_id,draft_id,employee_id,advance_id,amount,status,created_by) VALUES($1,$2,$3,$4,$5,'selected',$6)",[company(q),q.params.id,q.params.employeeId,x.advance_id,x.amount,getAuthenticatedContext(q)!.user.id]);
 const total=b.recoveries.reduce((v:any,x:any)=>v+cents(x.amount),0n);const gross=cents(line.salary)+cents(line.allowances)+cents(line.bonus)+cents(line.overtime);if(total+ cents(line.deductions)>gross){await c.query('ROLLBACK');return void error(s,'PAYROLL_INVALID');}
 await c.query('UPDATE payroll_drafts SET version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2',[q.params.id,company(q)]);await audit.logEvent({company_id:company(q),actor_user_id:getAuthenticatedContext(q)!.user.id,action:'payroll.advance_recovery.select',entity_type:'payroll_draft',entity_id:q.params.id,after_data:{employee_id:q.params.employeeId,recoveries:b.recoveries}},c);await c.query('COMMIT');s.json({recoveries:b.recoveries});
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}));
payrollRouter.get('/payroll/drafts/:id/employees/:employeeId/advance-recoveries',...read,requireCapability('payroll.employee_advance_recovery.view'),route(async(q,s)=>{
 if(!uuid.test(q.params.id)||!uuid.test(q.params.employeeId))return void error(s,'PAYROLL_INVALID');
 // The editor loads recovery options before a newly selected employee has a
 // payroll_draft_employees row. Validate draft and employee in the active
 // tenant independently of that row; selection still requires the line.
 const exists=(await pool!.query('SELECT 1 FROM payroll_drafts d JOIN employees e ON e.company_id=d.company_id WHERE d.company_id=$1 AND d.id=$2 AND e.id=$3',[company(q),q.params.id,q.params.employeeId])).rowCount;
 if(!exists)return void error(s,'PAYROLL_NOT_FOUND',404);
 const advances=(await pool!.query(`SELECT a.id advance_id,a.amount::text original_amount,a.issue_date::text,a.description,
   COALESCE(b.posted,0)::text recovered_amount,COALESCE(c.reversed,0)::text reversed_amount,(COALESCE(b.posted,0)-COALESCE(c.reversed,0))::text recognized_balance,
   COALESCE(r.reserved,0)::text reserved_balance,(a.amount-COALESCE(b.posted,0)+COALESCE(c.reversed,0)-COALESCE(r.reserved,0))::text available_balance,
   current.id current_recovery_id,current.amount::text current_amount,current.status current_status,current.expires_at::text reservation_expires_at
   FROM employee_salary_advances a
   LEFT JOIN LATERAL(SELECT sum(x.amount) posted FROM payroll_employee_advance_recoveries x WHERE x.company_id=a.company_id AND x.advance_id=a.id AND x.status='posted') b ON TRUE
   LEFT JOIN LATERAL(SELECT sum(cr.amount) reversed FROM payroll_recovery_corrections cr JOIN payroll_employee_advance_recoveries x ON x.id=cr.recovery_id AND x.company_id=cr.company_id WHERE cr.company_id=a.company_id AND x.advance_id=a.id AND cr.status='posted') c ON TRUE
   LEFT JOIN LATERAL(SELECT sum(x.amount) reserved FROM payroll_employee_advance_recoveries x WHERE x.company_id=a.company_id AND x.advance_id=a.id AND x.status='reserved' AND x.expires_at>clock_timestamp()) r ON TRUE
   LEFT JOIN LATERAL(SELECT x.id,x.amount,x.status,x.expires_at FROM payroll_employee_advance_recoveries x WHERE x.company_id=a.company_id AND x.advance_id=a.id AND x.draft_id=$2 AND x.employee_id=$3 AND x.status IN('selected','reserved','posted') ORDER BY x.created_at DESC LIMIT 1) current ON TRUE
   WHERE a.company_id=$1 AND a.employee_id=$3 AND a.status='issued' ORDER BY a.issue_date DESC,a.id`,[company(q),q.params.id,q.params.employeeId])).rows;
 s.json({advances});
}));
payrollRouter.post('/payroll/drafts/:id/approve',...approve,route(async(q,s)=>{
 const b=q.body;
 if(!uuid.test(q.params.id)||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).join(',')!=='version'||!Number.isInteger(b.version)||b.version<1)return void error(s,'PAYROLL_INVALID');
 const actor=getAuthenticatedContext(q)!.user.id;
 const c=await pool!.connect();try{
  await c.query('BEGIN');
  const draft=(await c.query('SELECT period_month::text,version,status FROM payroll_drafts WHERE id=$1 AND company_id=$2 FOR UPDATE',[q.params.id,company(q)])).rows[0];
  if(!draft){await c.query('ROLLBACK');return void error(s,'PAYROLL_NOT_FOUND',404);}
  if(draft.status==='approved'){await c.query('ROLLBACK');return void error(s,'PAYROLL_ALREADY_APPROVED',409);}
  if(draft.version!==b.version){await c.query('ROLLBACK');return void error(s,'PAYROLL_CONFLICT',409);}
  const years=(await c.query<{id:string;status:string}>(`SELECT id,status FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date ORDER BY start_date FOR SHARE`,[company(q),draft.period_month])).rows;
  if(years.length!==1||years[0]!.status!=='open'){await c.query('ROLLBACK');return void error(s,'PAYROLL_PERIOD_INELIGIBLE',409);}
  try{await assertAccountingDateWritable(company(q),draft.period_month,c);}catch(e){if((e as {code?:string}).code==='ACCOUNTING_PERIOD_CLOSED'||(e as {code?:string}).code==='FISCAL_YEAR_CLOSED'){await c.query('ROLLBACK');return void error(s,'PAYROLL_PERIOD_INELIGIBLE',409);}throw e;}
  const external=(await c.query(`SELECT 1 FROM ledger_source_authority WHERE company_id=$1 AND status='active' AND $2::date BETWEEN from_date AND to_date LIMIT 1`,[company(q),draft.period_month])).rowCount;
  if(external){await c.query('ROLLBACK');return void error(s,'PAYROLL_PERIOD_INELIGIBLE',409);}
  // Privileged payroll authority is role-specific; company Full Access is not a bypass.
  const privileged=await hasPrivilegedFinancialAuthority(c,company(q),actor);
  const contributed=(await c.query<{ok:boolean}>('SELECT EXISTS(SELECT 1 FROM payroll_draft_contributors WHERE company_id=$1 AND draft_id=$2 AND user_id=$3) AS ok',[company(q),q.params.id,actor])).rows[0]!.ok;
  if(contributed&&!privileged){await c.query('ROLLBACK');return void error(s,'PAYROLL_SELF_APPROVAL',403);}
  const totals=(await c.query<{count:string;invalid:string}>(`SELECT COUNT(*)::text AS count,
    COUNT(*) FILTER (WHERE salary+allowances+bonus+overtime<deductions+COALESCE((SELECT sum(r.amount) FROM payroll_employee_advance_recoveries r WHERE r.company_id=payroll_draft_employees.company_id AND r.draft_id=payroll_draft_employees.draft_id AND r.employee_id=payroll_draft_employees.employee_id AND r.status='selected'),0)
      OR (legacy_allowances IS NOT NULL AND allowances<>legacy_allowances+housing_allowance+transportation_allowance+other_allowance)
      OR (legacy_allowances IS NULL AND (housing_allowance<>0 OR transportation_allowance<>0 OR other_allowance<>0)))::text AS invalid
    FROM payroll_draft_employees WHERE company_id=$1 AND draft_id=$2`,[company(q),q.params.id])).rows[0]!;
  if(totals.count==='0'){await c.query('ROLLBACK');return void error(s,'PAYROLL_EMPTY',400);}
  if(totals.invalid!=='0'){await c.query('ROLLBACK');return void error(s,'PAYROLL_INVALID',400);}
  await c.query("UPDATE payroll_drafts SET status='approved',approved_by=$3,approved_at=NOW(),version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2",[q.params.id,company(q),actor]);
  const selected=(await c.query<{advance_id:string;amount:string}>('SELECT advance_id,amount::text FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND draft_id=$2 AND status=\'selected\' ORDER BY advance_id FOR UPDATE',[company(q),q.params.id])).rows;
  for(const x of selected){await c.query('SELECT id FROM employee_salary_advances WHERE id=$1 AND company_id=$2 FOR UPDATE',[x.advance_id,company(q)]);const sums=(await c.query<{used:string}>('SELECT (COALESCE(sum(amount) FILTER(WHERE status=\'posted\'),0)-COALESCE((SELECT sum(c.amount) FROM payroll_recovery_corrections c JOIN payroll_employee_advance_recoveries x ON x.id=c.recovery_id AND x.company_id=c.company_id WHERE c.company_id=$1 AND x.advance_id=$2 AND c.status=\'posted\'),0)+COALESCE(sum(amount) FILTER(WHERE status=\'reserved\' AND expires_at>clock_timestamp()),0))::text used FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2',[company(q),x.advance_id])).rows[0]!;const principal=(await c.query<{amount:string}>('SELECT amount::text FROM employee_salary_advances WHERE id=$1 AND company_id=$2 AND status=\'issued\'',[x.advance_id,company(q)] )).rows[0];if(!principal||cents(sums.used)+cents(x.amount)>cents(principal.amount)){await c.query('ROLLBACK');return void error(s,'PAYROLL_ADVANCE_BALANCE_EXCEEDED',409);}}
  const lease=(await c.query<{lease_days:number}>('SELECT COALESCE((SELECT lease_days FROM payroll_recovery_settings WHERE company_id=$1),30) lease_days',[company(q)])).rows[0]!.lease_days;
  await c.query("UPDATE payroll_employee_advance_recoveries SET status='reserved',reserved_at=clock_timestamp(),expires_at=clock_timestamp()+($3::text||' days')::interval WHERE company_id=$1 AND draft_id=$2 AND status='selected'",[company(q),q.params.id,lease]);
  await audit.logEvent({company_id:company(q),actor_user_id:actor,action:'payroll.draft.approve',entity_type:'payroll_draft',entity_id:q.params.id,
    after_data:{period_month:draft.period_month,version:draft.version+1,self_approval:contributed&&privileged,privileged_role_override:contributed&&privileged}},c);
  await c.query('COMMIT');await detail(q,s,draft.period_month);
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}));

payrollRouter.post('/payroll/drafts/:id/lifecycle',requireSameOrigin,...read,route(async(q,s)=>{
 const b=q.body;if(!uuid.test(q.params.id)||!b||!['return_to_draft','cancel','invalidate'].includes(b.action)||typeof b.reason!=='string'||b.reason.trim().length<10||b.reason.trim().length>1000)return void error(s,'PAYROLL_INVALID');
 const actor=getAuthenticatedContext(q)!.user.id,capabilities=getAuthenticatedContext(q)!.capabilities;
 if(!capabilities.includes('payroll.edit')||(b.action!=='cancel'&&!capabilities.includes('payroll.approve')))return void error(s,'FORBIDDEN',403);
 const c=await pool!.connect();try{await c.query('BEGIN');const d=(await c.query<{status:string;version:number;approved_by:string|null}>('SELECT status,version,approved_by FROM payroll_drafts WHERE id=$1 AND company_id=$2 FOR UPDATE',[q.params.id,company(q)])).rows[0];if(!d){await c.query('ROLLBACK');return void error(s,'PAYROLL_NOT_FOUND',404);}if(d.status!=='approved'&&d.status!=='draft'){await c.query('ROLLBACK');return void error(s,'PAYROLL_CONFLICT',409);}if(await c.query("SELECT 1 FROM journal_entries WHERE company_id=$1 AND source_type='payroll' AND source_id=$2 AND status='posted'",[company(q),q.params.id]).then(x=>x.rowCount)){await c.query('ROLLBACK');return void error(s,'PAYROLL_ALREADY_POSTED',409);}if(b.action==='return_to_draft'&&d.status!=='approved'){await c.query('ROLLBACK');return void error(s,'PAYROLL_CONFLICT',409);}if(b.action==='cancel'&&d.status!=='draft'){await c.query('ROLLBACK');return void error(s,'PAYROLL_CONFLICT',409);}
  if(b.action!=='cancel'){
   const privileged=await hasPrivilegedFinancialAuthority(c,company(q),actor);
   const approverId=d?.approved_by??null;const participant=(approverId!==null&&actor===approverId)||((await c.query('SELECT 1 FROM payroll_draft_contributors WHERE company_id=$1 AND draft_id=$2 AND user_id=$3',[company(q),q.params.id,actor])).rowCount??0)>0;
   if(participant&&!privileged){await c.query('ROLLBACK');return void error(s,'PAYROLL_LIFECYCLE_SEPARATION_OF_DUTIES',403);}
  }
  await c.query("UPDATE payroll_employee_advance_recoveries SET status='released',ended_at=clock_timestamp(),end_reason=$3 WHERE company_id=$1 AND draft_id=$2 AND status IN('selected','reserved')",[company(q),q.params.id,b.reason.trim()]);
  const next=b.action==='return_to_draft'?'draft':b.action==='cancel'?'cancelled':'invalidated';await c.query('UPDATE payroll_drafts SET status=$3,approved_by=CASE WHEN $3=\'draft\' THEN NULL ELSE approved_by END,approved_at=CASE WHEN $3=\'draft\' THEN NULL ELSE approved_at END,lifecycle_reason=$4,version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2',[q.params.id,company(q),next,b.reason.trim()]);await audit.logEvent({company_id:company(q),actor_user_id:actor,action:`payroll.draft.${b.action}`,entity_type:'payroll_draft',entity_id:q.params.id,before_data:{status:d.status},after_data:{status:next,reason:b.reason.trim(),released_reservations:true,advance_issuances_unchanged:true}},c);await c.query('COMMIT');s.json({status:next});
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}));

const accountingService=(res:Response)=>pool?new PayrollAccountingService(pool):(res.status(503).json({error:'Database unavailable',code:'DB_UNAVAILABLE'}),null);
const recoveryCorrectionService=(res:Response)=>pool?new PayrollRecoveryCorrectionService(pool):(res.status(503).json({error:'Database unavailable',code:'DB_UNAVAILABLE'}),null);
function accountingFailure(error:unknown,res:Response){if(error instanceof PayrollAccountingError){res.status(error.status).json({error:error.code,code:error.code,details:error.details});return true;}return false;}
payrollRouter.get('/payroll/account-mappings',...read,requireCapability('payroll.accounting.mapping.view'),route(async(q,s)=>{
 const service=accountingService(s);if(service)s.json(await service.mappings(company(q)));
}));
payrollRouter.put('/payroll/account-mappings/:key',requireSameOrigin,...read,requireCapability('payroll.accounting.mapping.view'),requireCapability('payroll.accounting.mapping.manage'),route(async(q,s)=>{
 const body=q.body;
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='account_id'||typeof body.account_id!=='string'||!uuid.test(body.account_id)||!PAYROLL_ACCOUNT_MAPPINGS.some(x=>x.key===q.params.key))return void error(s,'PAYROLL_MAPPING_INVALID');
 const service=accountingService(s);if(!service)return;
 try{s.json(await service.setMapping(company(q),getAuthenticatedContext(q)!.user.id,q.params.key as PayrollMappingKey,body.account_id));}
 catch(e){if(!accountingFailure(e,s))throw e;}
}));
payrollRouter.get('/payroll/drafts/:id/accounting-preview',...read,requireCapability('payroll.accounting.mapping.view'),requireCapability('payroll.accounting.preview'),route(async(q,s)=>{
 if(!uuid.test(q.params.id))return void error(s,'PAYROLL_INVALID');
 const service=accountingService(s);if(!service)return;
 try{s.json(await service.preview(company(q),q.params.id));}catch(e){if(!accountingFailure(e,s))throw e;}
}));

payrollRouter.get('/payroll/drafts/:id/bonus-options',...read,requireCapability('payroll.accounting.post'),
 requireCapability('employee_cost.salary.view'),route(async(q,s)=>{
 if(!uuid.test(q.params.id))return void error(s,'PAYROLL_INVALID');
 const rows=(await pool!.query(`
   SELECT e.id entitlement_id,p.employee_id,employee.display_name,e.period_start::text,e.period_end::text,
     LEAST(p.bonus,available.amount)::text maximum
   FROM payroll_drafts d
   JOIN payroll_draft_employees p ON p.company_id=d.company_id AND p.draft_id=d.id
   JOIN employees employee ON employee.company_id=p.company_id AND employee.id=p.employee_id
   JOIN employee_bonus_entitlements e ON e.company_id=p.company_id AND e.employee_id=p.employee_id
   JOIN employee_bonus_recognitions r ON r.company_id=e.company_id AND r.entitlement_id=e.id
   JOIN journal_entries j ON j.company_id=r.company_id AND j.id=r.journal_id AND j.status='posted'
   CROSS JOIN LATERAL (
     SELECT e.amount+COALESCE(sum(CASE WHEN b.kind IN ('increase','reversal') THEN b.amount ELSE -b.amount END),0) amount
     FROM employee_bonus_balance_entries b WHERE b.company_id=e.company_id AND b.entitlement_id=e.id
   ) available
   WHERE d.company_id=$1 AND d.id=$2 AND d.status='approved' AND p.bonus>0 AND available.amount>0
     AND r.accounting_date<d.period_month+interval '1 month'
     AND NOT EXISTS(SELECT 1 FROM journal_entries posted WHERE posted.company_id=d.company_id
       AND posted.source_type='payroll' AND posted.source_id=d.id AND posted.status='posted')
   ORDER BY employee.display_name,e.period_start,e.id
 `,[company(q),q.params.id])).rows;
 s.json({options:rows});
}));

payrollRouter.post('/payroll/drafts/:id/accounting-post',requireSameOrigin,...read,requireCapability('payroll.accounting.post'),route(async(q,s)=>{
 const body=q.body;
 if(!uuid.test(q.params.id)||!body||typeof body!=='object'||Array.isArray(body)||
    Object.keys(body).some(key=>key!=='bonus_allocations'))return void error(s,'PAYROLL_INVALID');
 const bonuses=body.bonus_allocations===undefined?[]:body.bonus_allocations;
 if(!Array.isArray(bonuses)||bonuses.length>100||bonuses.some(b=>!b||typeof b.entitlement_id!=='string'||
    !uuid.test(b.entitlement_id)||typeof b.amount!=='string'||!money.test(b.amount)||cents(b.amount)<=0n)||
    new Set(bonuses.map(b=>b.entitlement_id)).size!==bonuses.length)return void error(s,'PAYROLL_INVALID');
 const auth=getAuthenticatedContext(q)!;
 if(bonuses.length&&!auth.capabilities.includes('employee_cost.salary.view'))return void error(s,'FORBIDDEN',403);
 const service=accountingService(s);if(!service)return;
 try{const result=await service.post(company(q),q.params.id,auth.user.id,bonuses);s.status(result.existing?200:201).json(result);}catch(e){if(!accountingFailure(e,s))throw e;}
}));

payrollRouter.post('/payroll/recovery-corrections',requireSameOrigin,...read,requireCapability('payroll.employee_advance_recovery.correct'),route(async(q,s)=>{
 const b=q.body;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='accounting_date,amount,idempotency_key,reason,recovery_id'||!uuid.test(b.recovery_id)||!uuid.test(b.idempotency_key)||typeof b.amount!=='string'||!money.test(b.amount)||cents(b.amount)<=0n||typeof b.reason!=='string'||b.reason.trim().length<10||b.reason.trim().length>1000||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(b.accounting_date))return void error(s,'PAYROLL_RECOVERY_CORRECTION_INVALID');
 const svc=recoveryCorrectionService(s);if(!svc)return;try{const result=await svc.request(company(q),getAuthenticatedContext(q)!.user.id,{recoveryId:b.recovery_id,amount:b.amount,reason:b.reason,accountingDate:b.accounting_date,idempotencyKey:b.idempotency_key});s.status(result.existing?200:201).json(result);}catch(e){if(e instanceof PayrollRecoveryCorrectionError)return void error(s,e.code,e.status);throw e;}
}));
payrollRouter.get('/payroll/recovery-settings',...read,requireCapability('payroll.employee_advance_recovery.view'),route(async(q,s)=>{
 const svc=recoveryCorrectionService(s);if(svc)s.json(await svc.settings(company(q)));
}));
payrollRouter.put('/payroll/recovery-settings',requireSameOrigin,...read,requireCapability('payroll.employee_advance_recovery.configure'),route(async(q,s)=>{
 const b=q.body;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='correction_approval_days,lease_days'||!Number.isInteger(b.lease_days)||b.lease_days<1||b.lease_days>90||!Number.isInteger(b.correction_approval_days)||b.correction_approval_days<1||b.correction_approval_days>90)return void error(s,'PAYROLL_RECOVERY_SETTINGS_INVALID');
 const svc=recoveryCorrectionService(s);if(svc)s.json(await svc.setSettings(company(q),getAuthenticatedContext(q)!.user.id,{leaseDays:b.lease_days,correctionApprovalDays:b.correction_approval_days}));
}));
payrollRouter.get('/payroll/advance-recoveries',...read,requireCapability('payroll.employee_advance_recovery.view'),route(async(q,s)=>{
 const svc=recoveryCorrectionService(s);if(svc)s.json({recoveries:await svc.recoveries(company(q))});
}));
payrollRouter.get('/payroll/recovery-corrections',...read,requireCapability('payroll.employee_advance_recovery.view'),route(async(q,s)=>{
 const svc=recoveryCorrectionService(s);if(svc)s.json({corrections:await svc.list(company(q),getAuthenticatedContext(q)!.user.id)});
}));
payrollRouter.post('/payroll/recovery-corrections/:id/decision',requireSameOrigin,...read,requireCapability('payroll.employee_advance_recovery.correct.approve'),route(async(q,s)=>{
 const b=q.body;if(!uuid.test(q.params.id)||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='decision,reason'||!['approve','reject'].includes(b.decision)||typeof b.reason!=='string'||b.reason.trim().length<10||b.reason.trim().length>1000)return void error(s,'PAYROLL_RECOVERY_CORRECTION_INVALID');const svc=recoveryCorrectionService(s);if(!svc)return;try{s.json(await svc.decide(company(q),getAuthenticatedContext(q)!.user.id,q.params.id,b.decision,b.reason));}catch(e){if(e instanceof PayrollRecoveryCorrectionError)return void error(s,e.code,e.status);throw e;}
}));
payrollRouter.post('/payroll/recovery-corrections/:id/withdraw',requireSameOrigin,...read,requireCapability('payroll.employee_advance_recovery.correct'),route(async(q,s)=>{
 const b=q.body;if(!uuid.test(q.params.id)||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).join(',')!=='reason'||typeof b.reason!=='string'||b.reason.trim().length<10||b.reason.trim().length>1000)return void error(s,'PAYROLL_RECOVERY_CORRECTION_INVALID');const svc=recoveryCorrectionService(s);if(!svc)return;try{s.json(await svc.withdraw(company(q),getAuthenticatedContext(q)!.user.id,q.params.id,b.reason));}catch(e){if(e instanceof PayrollRecoveryCorrectionError)return void error(s,e.code,e.status);throw e;}
}));
payrollRouter.post('/payroll/recovery-corrections/:id/expire',requireSameOrigin,...read,requireCapability('payroll.employee_advance_recovery.correct'),route(async(q,s)=>{
 if(!uuid.test(q.params.id)||!q.body||typeof q.body!=='object'||Array.isArray(q.body)||Object.keys(q.body).length)return void error(s,'PAYROLL_RECOVERY_CORRECTION_INVALID');const svc=recoveryCorrectionService(s);if(!svc)return;try{s.json(await svc.expire(company(q),getAuthenticatedContext(q)!.user.id,q.params.id));}catch(e){if(e instanceof PayrollRecoveryCorrectionError)return void error(s,e.code,e.status);throw e;}
}));
payrollRouter.post('/payroll/recovery-corrections/:id/post',requireSameOrigin,...read,requireCapability('payroll.employee_advance_recovery.correct'),requireCapability('payroll.accounting.post'),route(async(q,s)=>{
 if(!uuid.test(q.params.id)||!q.body||typeof q.body!=='object'||Array.isArray(q.body)||Object.keys(q.body).length)return void error(s,'PAYROLL_RECOVERY_CORRECTION_INVALID');const svc=recoveryCorrectionService(s);if(!svc)return;try{const result=await svc.post(company(q),getAuthenticatedContext(q)!.user.id,q.params.id);if(result.expired)return void error(s,'PAYROLL_RECOVERY_CORRECTION_EXPIRED',409);s.status(result.existing?200:201).json(result);}catch(e){if(e instanceof PayrollRecoveryCorrectionError)return void error(s,e.code,e.status);throw e;}
}));

payrollRouter.get('/payroll/drafts/:id/accounting-post-status',...read,requirePostingStatusRead,route(async(q,s)=>{
 if(!uuid.test(q.params.id))return void error(s,'PAYROLL_INVALID');
 const service=accountingService(s);if(!service)return;
 try{s.json(await service.postingStatus(company(q),q.params.id,getAuthenticatedContext(q)!.user.id));}catch(e){if(!accountingFailure(e,s))throw e;}
}));

payrollRouter.get('/payroll/settlements/liabilities',...read,requireCapability('payroll.settlement.view'),route(async(q,s)=>{
 if(!pool)return void error(s,'DB_UNAVAILABLE',503);
 s.json({liabilities:await new PayrollSettlementService(pool).liabilities(company(q))});
}));
payrollRouter.get('/payroll/settlements/bank-transactions',...read,requireCapability('payroll.settlement.view'),requireCapability('bank.view'),route(async(q,s)=>{
 if(!pool)return void error(s,'DB_UNAVAILABLE',503);
 s.json({bank_transactions:await new PayrollSettlementService(pool).banks(company(q))});
}));
payrollRouter.get('/payroll/settlements',...read,requireCapability('payroll.settlement.view'),requireCapability('bank.view'),route(async(q,s)=>{
 if(!pool)return void error(s,'DB_UNAVAILABLE',503);
 s.json({settlements:await new PayrollSettlementService(pool).history(company(q))});
}));
payrollRouter.post('/payroll/settlements/sod-exceptions',requireSameOrigin,...read,requireCapability('payroll.settlement.create'),route(async(q,s)=>{
 const body=q.body;
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='liability_line_id,reason'
   ||typeof body.liability_line_id!=='string'||!uuid.test(body.liability_line_id)||typeof body.reason!=='string'||body.reason.trim().length<8||body.reason.trim().length>1000)return void error(s,'PAYROLL_SETTLEMENT_SOD_EXCEPTION_INVALID');
 if(!pool)return void error(s,'DB_UNAVAILABLE',503);
 try{s.status(201).json(await new PayrollSettlementService(pool).requestSodException(company(q),getAuthenticatedContext(q)!.user.id,body.liability_line_id,body.reason));}
 catch(e){if(e instanceof PayrollSettlementError)return void error(s,e.code,e.status);throw e;}
}));
payrollRouter.get('/payroll/settlements/sod-exceptions',...read,requireCapability('payroll.settlement.view'),route(async(q,s)=>{
 if(!pool)return void error(s,'DB_UNAVAILABLE',503);
 try{s.json({exceptions:await new PayrollSettlementService(pool).listSodExceptions(company(q),getAuthenticatedContext(q)!.user.id)});}
 catch(e){if(e instanceof PayrollSettlementError)return void error(s,e.code,e.status);throw e;}
}));
payrollRouter.post('/payroll/settlements/sod-exceptions/:id/decision',requireSameOrigin,...read,requireCapability(PAYROLL_SETTLEMENT_EXCEPTION_APPROVER_CAPABILITY),route(async(q,s)=>{
 const body=q.body;
 if(!uuid.test(q.params.id)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='decision,reason'
   ||!['approve','reject'].includes(body.decision)||typeof body.reason!=='string'||body.reason.trim().length<8||body.reason.trim().length>1000)return void error(s,'PAYROLL_SETTLEMENT_SOD_EXCEPTION_INVALID');
 if(!pool)return void error(s,'DB_UNAVAILABLE',503);
 try{s.json(await new PayrollSettlementService(pool).decideSodException(company(q),getAuthenticatedContext(q)!.user.id,q.params.id,body.decision,body.reason));}
 catch(e){if(e instanceof PayrollSettlementError)return void error(s,e.code,e.status);throw e;}
}));
payrollRouter.post('/payroll/settlements',requireSameOrigin,...read,requireCapability('payroll.settlement.create'),requireCapability('bank.view'),route(async(q,s)=>{
 const b=q.body;
 if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['amount','bank_transaction_id','idempotency_key','liability_line_id','sod_exception_id'].includes(k))
   ||Object.keys(b).sort().join(',')!==['amount','bank_transaction_id','idempotency_key','liability_line_id',...(b.sod_exception_id===undefined?[]:['sod_exception_id'])].sort().join(',')
   ||![b.bank_transaction_id,b.idempotency_key,b.liability_line_id].every(v=>typeof v==='string'&&uuid.test(v))
   ||(b.sod_exception_id!==undefined&&(typeof b.sod_exception_id!=='string'||!uuid.test(b.sod_exception_id)))
   ||typeof b.amount!=='string'||!money.test(b.amount)||cents(b.amount)<=0n||cents(b.amount)>maxMoney) return void error(s,'PAYROLL_SETTLEMENT_INVALID');
 if(!pool)return void error(s,'DB_UNAVAILABLE',503);
 try {const result=await new PayrollSettlementService(pool).create(company(q),getAuthenticatedContext(q)!.user.id,{bankTransactionId:b.bank_transaction_id,liabilityLineId:b.liability_line_id,amount:b.amount,idempotencyKey:b.idempotency_key,sodExceptionId:b.sod_exception_id,canSettleBonus:getAuthenticatedContext(q)!.capabilities.includes('employee_cost.salary.view')});s.status(result.existing?200:201).json(result);}
 catch(e){if(e instanceof PayrollSettlementError)return void error(s,e.code,e.status);throw e;}
}));
