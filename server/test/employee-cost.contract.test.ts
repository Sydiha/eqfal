import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitySensitivity } from '../src/modules/memberships/capability-sensitivity';

const migration=readFileSync(join(__dirname,'../migrations/112_employee_cost_center.sql'),'utf8');
const service=readFileSync(join(__dirname,'../src/modules/employee-costs/employee-cost.service.ts'),'utf8');
const router=readFileSync(join(__dirname,'../src/modules/employee-costs/employee-cost.router.ts'),'utf8');
const app=readFileSync(join(__dirname,'../src/app.ts'),'utf8');

describe('ECC-01 employee registry and manually recorded cost contract',()=>{
  it('registers dedicated capabilities without granting them to roles',()=>{
    for(const c of ['employee.view','employee.manage','employee_cost.view','employee_cost.salary.view','employee_cost.create','employee_cost.approve','employee_cost.correct'])expect(migration).toContain(`('${c}')`);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+role_capabilities/i);
    expect(capabilitySensitivity('employee_cost.salary.view')).toBe('critical');
  });
  it('keeps employee identity independent from accounts and counterparties with company-scoped cost links',()=>{
    const table=migration.split('CREATE TABLE employees')[1]!.split('CREATE INDEX employees')[0]!;
    expect(table).not.toMatch(/\b(user_id|counterparty_id|partner_id)\b/);
    expect(table).toContain('UNIQUE (id, company_id)');
    expect(migration).toMatch(/FOREIGN KEY \(employee_id, company_id\) REFERENCES employees\(id, company_id\)/);
    expect(migration).toMatch(/FOREIGN KEY \(fiscal_year_id, company_id\) REFERENCES fiscal_years\(id, company_id\)/);
  });
  it('supports the required categories and keeps nature separate from category',()=>{
    for(const c of ['salary','allowances','bonus','overtime','employer_gosi','employee_deduction','residency','work_permit','medical_insurance','travel_benefit','end_of_service','other'])expect(migration).toContain(`'${c}'`);
    expect(migration).toContain("nature IN ('earning','employer_cost','employee_deduction')");
    expect(service).toContain("category === 'employee_deduction' ? 'employee_deduction'");
  });
  it('makes allocation months unique, requires exact total allocation at approval and freezes approved rows',()=>{
    expect(migration).toContain('UNIQUE (company_id, cost_record_id, allocation_month)');
    expect(migration).toContain('Employee cost allocations must equal the record total');
    expect(migration).toContain('Approved employee cost records are immutable');
    expect(migration).toContain('Allocations can only change while the cost record is a draft');
    expect(migration).toContain('employee_cost_records_one_correction_idx');
  });
  it('hides earnings and deductions without the dedicated salary permission and excludes corrected predecessors from reports',()=>{
    expect(router).toContain("ctx(q).capabilities.includes('employee_cost.salary.view')");
    expect(service).toContain("($4::boolean OR r.nature='employer_cost')");
    expect(service).toMatch(/newer\.supersedes_id=r\.id AND newer\.status='approved'/);
    expect(service).toMatch(/if \(!salaryVisible && rows\.some/);
  });
  it('requires company-scoped routes, locks approval/correction writes and audits within the transaction',()=>{
    expect(router).toContain("requireAll('employee.view','employee_cost.correct','employee_cost.approve')");
    expect(router).toContain("requireCapability('employee_cost.view')");
    expect(service).toMatch(/FROM employee_cost_records WHERE id=\$1 AND company_id=\$2 FOR UPDATE/);
    expect(service).toContain("action:'employee_cost.corrected'");
    expect(service).toContain("action:'employee_cost.correction_approve'");
    expect(app).toContain('app.use(\'/api\', employeeCostRouter)');
    expect(service).not.toMatch(/postJournalInTransaction|bank_transactions|journal_lines/);
  });
});
