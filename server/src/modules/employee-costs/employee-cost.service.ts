import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { lockPayrollEccMonths, hasPostedPayrollOverlap } from '../payroll/payroll-ecc-lock';

export const EMPLOYEE_COST_CATEGORIES = ['salary','allowances','bonus','overtime','employer_gosi','employee_deduction','residency','work_permit','medical_insurance','travel_benefit','end_of_service','other'] as const;
export const EMPLOYEE_COST_NATURES = ['earning','employer_cost','employee_deduction'] as const;
export type EmployeeCostCategory = typeof EMPLOYEE_COST_CATEGORIES[number];
export type EmployeeCostNature = typeof EMPLOYEE_COST_NATURES[number];
export type AllocationInput = { fiscal_year_id: string; allocation_month: string; amount: string };
export type CostInput = {
  category: EmployeeCostCategory; nature: EmployeeCostNature; currency_code: string; total_amount: string;
  service_period_start: string; service_period_end: string; description: string; allocations: AllocationInput[];
};

export class EmployeeCostError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const invalid = (message = 'Invalid employee cost request') => new EmployeeCostError(400, 'EMPLOYEE_COST_INVALID', message);
const missing = () => new EmployeeCostError(404, 'EMPLOYEE_COST_NOT_FOUND', 'Not found');
const conflict = (message = 'The employee cost record changed; refresh and try again') => new EmployeeCostError(409, 'EMPLOYEE_COST_CONFLICT', message);
const forbidden = () => new EmployeeCostError(403, 'FORBIDDEN', 'Forbidden');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const cents = (v: string) => { const [whole, fraction = ''] = v.split('.'); return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')); };
const money = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const monthFloor = (v: string) => `${v.slice(0, 7)}-01`;
const monthCeiling = (v: string) => { const d = new Date(`${v}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 0); return d.toISOString().slice(0, 10); };
const expectedNature = (category: EmployeeCostCategory): EmployeeCostNature => category === 'employee_deduction' ? 'employee_deduction' : ['salary','allowances','bonus','overtime'].includes(category) ? 'earning' : 'employer_cost';
type Employee = { id: string; company_id: string; employee_number: string; display_name: string; employment_start: string | null; employment_end: string | null; is_active: boolean; version: number };
type CostRecord = { id: string; company_id: string; employee_id: string; category: EmployeeCostCategory; nature: EmployeeCostNature; currency_code: string; total_amount: string; service_period_start: string; service_period_end: string; description: string; status: 'draft'|'approved'; version: number; supersedes_id: string | null; correction_reason: string | null; created_by: string; created_at: string; approved_by: string | null; approved_at: string | null };

export class EmployeeCostService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.db.connect();
    try { await c.query('BEGIN'); const value = await fn(c); await c.query('COMMIT'); return value; }
    catch (e) {
      await c.query('ROLLBACK');
      const err = e as { code?: string; constraint?: string };
      if (err.code === '23503') throw missing();
      if (err.code === '23505') throw conflict(err.constraint === 'employee_cost_allocations_company_id_cost_record_id_allocation_month_key' ? 'An allocation for this record and month already exists' : 'The record conflicts with an existing employee or correction');
      if (err.code === '23514' && err.constraint === 'employee_cost_payment_active') throw new EmployeeCostError(409, 'EMPLOYEE_COST_PAYMENT_ACTIVE', 'Reverse all active payments before correcting this employee cost');
      if (err.code === '23514') throw invalid('The record violates an allocation or status rule');
      if (err.code === '55000') throw conflict('Approved records and allocations are immutable');
      throw e;
    } finally { c.release(); }
  }

  async employees(companyId: string) {
    const rows = (await this.db.query<Employee>(`SELECT id,company_id,employee_number,display_name,employment_start::text,employment_end::text,is_active,version FROM employees WHERE company_id=$1 ORDER BY is_active DESC,employee_number,id`, [companyId])).rows;
    return { employees: rows };
  }

  async createEmployee(companyId: string, actor: string, input: { employee_number: string; display_name: string; employment_start: string | null; employment_end: string | null }) {
    return this.tx(async c => {
      const row = (await c.query<Employee>(`INSERT INTO employees(company_id,employee_number,display_name,employment_start,employment_end,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,company_id,employee_number,display_name,employment_start::text,employment_end::text,is_active,version`, [companyId,input.employee_number,input.display_name,input.employment_start,input.employment_end,actor])).rows[0]!;
      await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'employee.create',entity_type:'employee',entity_id:row.id,after_data:{version:row.version}},c);
      return row;
    });
  }

  async updateEmployee(companyId: string, actor: string, id: string, expectedVersion: number, patch: { employee_number?: string; display_name?: string; employment_start?: string | null; employment_end?: string | null; is_active?: boolean }) {
    return this.tx(async c => {
      const before = (await c.query<Employee>('SELECT id,company_id,employee_number,display_name,employment_start::text,employment_end::text,is_active,version FROM employees WHERE id=$1 AND company_id=$2 FOR UPDATE',[id,companyId])).rows[0];
      if (!before) throw missing();
      if (before.version !== expectedVersion) throw conflict();
      const after = (await c.query<Employee>(`UPDATE employees SET employee_number=$3,display_name=$4,employment_start=$5,employment_end=$6,is_active=$7,version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING id,company_id,employee_number,display_name,employment_start::text,employment_end::text,is_active,version`,[id,companyId,patch.employee_number??before.employee_number,patch.display_name??before.display_name,patch.employment_start===undefined?before.employment_start:patch.employment_start,patch.employment_end===undefined?before.employment_end:patch.employment_end,patch.is_active??before.is_active])).rows[0]!;
      await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:after.is_active?'employee.update':'employee.deactivate',entity_type:'employee',entity_id:id,before_data:{version:before.version,is_active:before.is_active},after_data:{version:after.version,is_active:after.is_active}},c);
      return after;
    });
  }

  private validateCost(v: CostInput) {
    if (!EMPLOYEE_COST_CATEGORIES.includes(v.category) || v.nature !== expectedNature(v.category)) throw invalid('The category and cost nature do not match');
    if (!/^[A-Z]{3}$/.test(v.currency_code) || !money.test(v.total_amount) || cents(v.total_amount) <= 0n) throw invalid();
    if (!isDate(v.service_period_start) || !isDate(v.service_period_end) || v.service_period_end < v.service_period_start) throw invalid();
    if (!v.description.trim() || v.description.trim().length > 500 || !Array.isArray(v.allocations) || v.allocations.length < 1 || v.allocations.length > 120) throw invalid();
    const months = new Set<string>(); let total = 0n;
    for (const a of v.allocations) {
      if (!UUID.test(a.fiscal_year_id) || !isDate(a.allocation_month) || a.allocation_month !== monthFloor(a.allocation_month) || !money.test(a.amount) || cents(a.amount) <= 0n) throw invalid();
      if (a.allocation_month < monthFloor(v.service_period_start) || a.allocation_month > monthFloor(v.service_period_end)) throw invalid('An allocation month is outside the service period');
      if (months.has(a.allocation_month)) throw invalid('Duplicate allocation month');
      months.add(a.allocation_month); total += cents(a.amount);
    }
    if (total !== cents(v.total_amount)) throw invalid('Monthly allocations must equal the recorded total');
  }

  private async insertAllocations(c: PoolClient, companyId: string, recordId: string, v: CostInput) {
    for (const a of v.allocations) {
      const fy = (await c.query<{start_date:string;end_date:string}>('SELECT start_date::text,end_date::text FROM fiscal_years WHERE id=$1 AND company_id=$2 FOR SHARE',[a.fiscal_year_id,companyId])).rows[0];
      if (!fy || monthFloor(fy.end_date) < a.allocation_month || fy.start_date > monthCeiling(a.allocation_month)) throw invalid('The allocation month does not overlap its selected fiscal year');
      await c.query('INSERT INTO employee_cost_allocations(company_id,cost_record_id,fiscal_year_id,allocation_month,amount) VALUES($1,$2,$3,$4,$5)',[companyId,recordId,a.fiscal_year_id,a.allocation_month,a.amount]);
    }
  }

  private async insertRecord(c: PoolClient, companyId: string, actor: string, employeeId: string, v: CostInput, correction?: { supersedesId: string; reason: string }) {
    this.validateCost(v);
    if (!(await c.query('SELECT 1 FROM employees WHERE id=$1 AND company_id=$2 FOR SHARE',[employeeId,companyId])).rowCount) throw missing();
    const row = (await c.query<CostRecord>(`INSERT INTO employee_cost_records(company_id,employee_id,category,nature,currency_code,total_amount,service_period_start,service_period_end,description,supersedes_id,correction_reason,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *,service_period_start::text,service_period_end::text,approved_at::text,created_at::text`,[companyId,employeeId,v.category,v.nature,v.currency_code,v.total_amount,v.service_period_start,v.service_period_end,v.description.trim(),correction?.supersedesId??null,correction?.reason??null,actor])).rows[0]!;
    await this.insertAllocations(c,companyId,row.id,v);
    return row;
  }

  async createCost(companyId: string, actor: string, employeeId: string, v: CostInput) {
    return this.tx(async c => {
      const row = await this.insertRecord(c,companyId,actor,employeeId,v);
      await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'employee_cost.create',entity_type:'employee_cost_record',entity_id:row.id,after_data:{status:'draft',version:row.version,allocation_count:v.allocations.length}},c);
      return { record: row, allocations: v.allocations };
    });
  }

  async approveCost(companyId: string, actor: string, id: string, expectedVersion: number, salaryVisible: boolean) {
    return this.tx(async c => {
      const before = (await c.query<CostRecord>('SELECT *,service_period_start::text,service_period_end::text FROM employee_cost_records WHERE id=$1 AND company_id=$2 FOR UPDATE',[id,companyId])).rows[0];
      if (!before) throw missing();
      if (before.nature !== 'employer_cost' && !salaryVisible) throw forbidden();
      if (before.status !== 'draft' || before.version !== expectedVersion || before.supersedes_id) throw conflict();
      const months = (await c.query<{allocation_month:string}>('SELECT allocation_month::text AS allocation_month FROM employee_cost_allocations WHERE company_id=$1 AND cost_record_id=$2 ORDER BY allocation_month',[companyId,id])).rows.map(x=>x.allocation_month);
      await lockPayrollEccMonths(c,companyId,months);
      if (await hasPostedPayrollOverlap(c,companyId,id)) throw new EmployeeCostError(409,'EMPLOYEE_COST_PAYROLL_POSTED_OVERLAP','The allocation overlaps posted payroll for this employee and month');
      const after = (await c.query<CostRecord>(`UPDATE employee_cost_records SET status='approved',approved_by=$3,approved_at=NOW(),version=version+1 WHERE id=$1 AND company_id=$2 RETURNING *,service_period_start::text,service_period_end::text,approved_at::text,created_at::text`,[id,companyId,actor])).rows[0]!;
      await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'employee_cost.approve',entity_type:'employee_cost_record',entity_id:id,before_data:{status:before.status,version:before.version},after_data:{status:'approved',version:after.version}},c);
      return after;
    });
  }

  async correctCost(companyId: string, actor: string, id: string, reason: string, v: CostInput, salaryVisible: boolean) {
    return this.tx(async c => {
      const before = (await c.query<CostRecord>('SELECT *,service_period_start::text,service_period_end::text FROM employee_cost_records WHERE id=$1 AND company_id=$2 FOR UPDATE',[id,companyId])).rows[0];
      if (!before || before.status !== 'approved') throw missing();
      if (!salaryVisible && (before.nature !== 'employer_cost' || v.nature !== 'employer_cost')) throw forbidden();
      const existing = await c.query('SELECT 1 FROM employee_cost_records WHERE company_id=$1 AND supersedes_id=$2',[companyId,id]);
      if (existing.rowCount) throw conflict('This approved record already has a correction');
      const replacement = await this.insertRecord(c,companyId,actor,before.employee_id,v,{supersedesId:id,reason});
      const oldMonths = (await c.query<{allocation_month:string}>('SELECT allocation_month::text AS allocation_month FROM employee_cost_allocations WHERE company_id=$1 AND cost_record_id=$2 ORDER BY allocation_month',[companyId,id])).rows.map(x=>x.allocation_month);
      await lockPayrollEccMonths(c,companyId,[...oldMonths,...v.allocations.map(x=>x.allocation_month)]);
      if (await hasPostedPayrollOverlap(c,companyId,replacement.id)) throw new EmployeeCostError(409,'EMPLOYEE_COST_PAYROLL_POSTED_OVERLAP','The allocation overlaps posted payroll for this employee and month');
      const after = (await c.query<CostRecord>(`UPDATE employee_cost_records SET status='approved',approved_by=$3,approved_at=NOW(),version=version+1 WHERE id=$1 AND company_id=$2 RETURNING *,service_period_start::text,service_period_end::text,approved_at::text,created_at::text`,[replacement.id,companyId,actor])).rows[0]!;
      await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'employee_cost.corrected',entity_type:'employee_cost_record',entity_id:id,after_data:{replacement_id:after.id}},c);
      await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'employee_cost.correction_approve',entity_type:'employee_cost_record',entity_id:after.id,after_data:{status:'approved',version:after.version,supersedes_id:id}},c);
      return { record: after, allocations: v.allocations };
    });
  }

  async updateDraftCost(companyId: string, actor: string, id: string, expectedVersion: number, v: CostInput, salaryVisible: boolean) {
    return this.tx(async c => {
      const before = (await c.query<CostRecord>('SELECT *,service_period_start::text,service_period_end::text FROM employee_cost_records WHERE id=$1 AND company_id=$2 FOR UPDATE',[id,companyId])).rows[0];
      if (!before) throw missing();
      if (!salaryVisible && (before.nature !== 'employer_cost' || v.nature !== 'employer_cost')) throw forbidden();
      if (before.status !== 'draft' || before.version !== expectedVersion || before.supersedes_id) throw conflict();
      this.validateCost(v);
      await c.query('DELETE FROM employee_cost_allocations WHERE cost_record_id=$1 AND company_id=$2',[id,companyId]);
      await this.insertAllocations(c,companyId,id,v);
      const after=(await c.query<CostRecord>(`UPDATE employee_cost_records SET category=$3,nature=$4,currency_code=$5,total_amount=$6,service_period_start=$7,service_period_end=$8,description=$9,version=version+1 WHERE id=$1 AND company_id=$2 RETURNING *,service_period_start::text,service_period_end::text`,[id,companyId,v.category,v.nature,v.currency_code,v.total_amount,v.service_period_start,v.service_period_end,v.description.trim()])).rows[0]!;
      await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'employee_cost.update_draft',entity_type:'employee_cost_record',entity_id:id,before_data:{status:before.status,version:before.version},after_data:{status:after.status,version:after.version,allocation_count:v.allocations.length}},c);
      return {record:after,allocations:v.allocations};
    });
  }

  async listCosts(companyId: string, salaryVisible: boolean) {
    const rows=(await this.db.query(`SELECT r.id,r.employee_id,e.employee_number,e.display_name,r.category,r.nature,r.currency_code,r.total_amount::text,r.service_period_start::text,r.service_period_end::text,r.description,r.status,r.version,r.supersedes_id,r.correction_reason,r.created_at,r.approved_at::text,
        COALESCE(json_agg(json_build_object('id',a.id,'allocation_month',a.allocation_month::text,'fiscal_year_id',a.fiscal_year_id,'amount',a.amount::text) ORDER BY a.allocation_month) FILTER (WHERE a.id IS NOT NULL),'[]') allocations
      FROM employee_cost_records r JOIN employees e ON e.id=r.employee_id AND e.company_id=r.company_id
      LEFT JOIN employee_cost_allocations a ON a.cost_record_id=r.id AND a.company_id=r.company_id
      WHERE r.company_id=$1 AND ($2::boolean OR r.nature='employer_cost')
      GROUP BY r.id,e.employee_number,e.display_name ORDER BY r.created_at DESC,r.id`,[companyId,salaryVisible])).rows;
    return { records: rows };
  }

  async report(companyId: string, fiscalYearId: string, month: string | null, salaryVisible: boolean) {
    const fy=(await this.db.query<{start_date:string;end_date:string;name:string}>(`SELECT start_date::text,end_date::text,name FROM fiscal_years WHERE id=$1 AND company_id=$2`,[fiscalYearId,companyId])).rows[0];
    if (!fy) throw missing();
    if (month && (!isDate(month) || month !== monthFloor(month) || month > fy.end_date || monthCeiling(month) < fy.start_date)) throw invalid('Month is outside the fiscal year');
    const rows=(await this.db.query(`SELECT e.id employee_id,e.employee_number,e.display_name,r.category,r.nature,
        CASE WHEN $3::date IS NULL THEN NULL ELSE a.allocation_month::text END allocation_month,
        r.currency_code,SUM(a.amount)::text amount
      FROM employee_cost_allocations a JOIN employee_cost_records r ON r.id=a.cost_record_id AND r.company_id=a.company_id
      JOIN employees e ON e.id=r.employee_id AND e.company_id=r.company_id
      WHERE a.company_id=$1 AND a.fiscal_year_id=$2 AND ($3::date IS NULL OR a.allocation_month=$3)
        AND r.status='approved' AND ($4::boolean OR r.nature='employer_cost')
        AND NOT EXISTS (SELECT 1 FROM employee_cost_records newer WHERE newer.company_id=r.company_id AND newer.supersedes_id=r.id AND newer.status='approved')
      GROUP BY e.id,e.employee_number,e.display_name,r.category,r.nature,
        CASE WHEN $3::date IS NULL THEN NULL ELSE a.allocation_month::text END,r.currency_code
      ORDER BY e.employee_number,e.display_name,r.nature,r.category,allocation_month,r.currency_code`,[companyId,fiscalYearId,month,salaryVisible])).rows;
    return { fiscal_year: {id:fiscalYearId,name:fy.name,start_date:fy.start_date,end_date:fy.end_date}, month, basis:'approved_recorded_costs', salary_details_included:salaryVisible, not_verified_payments_or_posted_expenses:true, rows };
  }

  async history(companyId: string, id: string, salaryVisible: boolean) {
    const rows=(await this.db.query(`WITH RECURSIVE lineage AS (
        SELECT r.* FROM employee_cost_records r WHERE r.id=$1 AND r.company_id=$2
        UNION
        SELECT r.* FROM employee_cost_records r JOIN lineage l ON r.company_id=l.company_id AND (r.id=l.supersedes_id OR r.supersedes_id=l.id)
      ) SELECT id,employee_id,category,nature,currency_code,total_amount::text,service_period_start::text,service_period_end::text,description,status,version,supersedes_id,correction_reason,created_at,approved_by,approved_at::text FROM lineage ORDER BY created_at,id`,[id,companyId])).rows;
    if (!rows.length) throw missing();
    if (!salaryVisible && rows.some((row: {nature:string}) => row.nature !== 'employer_cost')) throw forbidden();
    return { history: rows };
  }

  async fiscalYears(companyId: string) {
    return { fiscal_years:(await this.db.query(`SELECT id,name,start_date::text,end_date::text,status FROM fiscal_years WHERE company_id=$1 ORDER BY start_date DESC`,[companyId])).rows };
  }
}
