import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration=readFileSync(new URL('../migrations/124_employee_salary_advance_foundation.sql',import.meta.url),'utf8');
const service=readFileSync(new URL('../src/modules/employee-advances/employee-salary-advance.service.ts',import.meta.url),'utf8');
const posting=readFileSync(new URL('../src/modules/accounting/employee-advance-posting.ts',import.meta.url),'utf8');
const journal=readFileSync(new URL('../src/modules/accounting/journal-posting.ts',import.meta.url),'utf8');

describe('employee salary advance foundation contracts',()=>{
 it('uses explicit lifecycle and keeps advances independent of custody and payroll deductions',()=>{
  expect(migration).toContain("('draft','approved','pending_posting','issued')");
  expect(migration).toContain('employee_advance_funding');
  expect(migration).not.toMatch(/custody_id\s+UUID.*employee_salary_advances/s);
  expect(service).not.toMatch(/INSERT INTO custody_advances|INSERT INTO payroll_settlement_allocations|payroll_deduction/);
 });
 it('serializes bank ownership and protects queued and issued source history',()=>{
  expect(migration).toContain('FOR UPDATE');
  expect(migration).toContain('employee_salary_advance_bank_claim_guard');
  expect(migration).toContain('employee_salary_advance_match_guard');
  expect(migration).toContain('employee_salary_advance_bank_transaction_guard');
  expect(service).toContain('FOR UPDATE`');
  expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION guard_(?:payroll_bank_ownership|shared_bank_transaction_allocation)/);
 });
 it('requires the exact receivable debit and bank credit and issues only in canonical posting',()=>{
  expect(posting).toContain('must debit the receivable and credit the linked bank ledger');
  expect(service).toContain("'employee_advance_receivable'");
  expect(service).toContain("'employee_advance_bank'");
  expect(journal).toContain('assertEmployeeAdvanceJournal(client, companyId, id, operationalSource)');
  expect(journal).toMatch(/SET status='issued',journal_entry_id=\$3/);
 });
});
