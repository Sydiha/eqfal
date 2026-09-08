import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import type {PoolClient} from 'pg';
import {AccountingPeriodClosedError,assertAccountingRangeWritable} from '../src/modules/monthly-close/accounting-period.guard';
import {vi} from 'vitest';

const accounting=readFileSync(new URL('../src/modules/accounting/accounting.router.ts',import.meta.url),'utf8');
const periodic=readFileSync(new URL('../src/modules/periodic-adjustments/periodic-adjustments.router.ts',import.meta.url),'utf8');

describe('Phase 5A closed-period mutation coverage',()=>{
 it('guards draft journal updates before UPDATE for current and destination dates',()=>{
  expect(accounting).toContain("await assertAccountingDateWritable(companyId,before.accounting_date,client)");
  expect(accounting).toContain("if(merged.accountingDate!==before.accounting_date)await assertAccountingDateWritable(companyId,merged.accountingDate,client)");
  expect(accounting.indexOf('await assertAccountingDateWritable(companyId,before.accounting_date,client)')).toBeLessThan(accounting.indexOf('UPDATE journal_entries SET'));
 });
 it('guards draft journal line replacement before DELETE and INSERT',()=>{
  const start=accounting.indexOf('async replaceLines');
  const section=accounting.slice(start,accounting.indexOf('async post',start));
  expect(section).toContain('await assertAccountingDateWritable(companyId,journal.accounting_date,client)');
  expect(section.indexOf('await assertAccountingDateWritable')).toBeLessThan(section.indexOf('DELETE FROM journal_lines'));
  expect(section.indexOf('await assertAccountingDateWritable')).toBeLessThan(section.indexOf('INSERT INTO journal_lines'));
 });
 it('guards every periodic-adjustment recognition range and historical state transition',()=>{
  expect(periodic).toContain('await assertAccountingRangeWritable(company,input.start,input.end,c)');
  expect(periodic).toContain('await assertAccountingRangeWritable(company,before.recognition_start,before.recognition_end,c)');
  expect(periodic).toContain('INSERT INTO periodic_adjustment_schedule');
  expect(periodic.indexOf('await assertAccountingRangeWritable(company,input.start,input.end,c)')).toBeLessThan(periodic.indexOf('INSERT INTO periodic_adjustments'));
 });
});

describe('Phase 5A range locking and tenant isolation',()=>{
 it('locks all intersected months deterministically and rejects a closed month anywhere in range',async()=>{
  const query=vi.fn(async(sql:string,params?:unknown[])=>{
   if(sql.includes('pg_advisory_xact_lock'))return{rows:[],rowCount:1};
   if(sql.includes('monthly_close_periods')){expect(params).toEqual(['company-a','2026-01-15','2026-03-10']);return{rows:[{one:1}],rowCount:1};}
   throw new Error(sql);
  });
  const client={query} as unknown as PoolClient;
  await expect(assertAccountingRangeWritable('company-a','2026-01-15','2026-03-10',client)).rejects.toBeInstanceOf(AccountingPeriodClosedError);
  expect(query.mock.calls.filter(([sql])=>String(sql).includes('pg_advisory_xact_lock')).map(([,p])=>(p as string[])[0])).toEqual([
   'accounting-period:company-a:2026-01','accounting-period:company-a:2026-02','accounting-period:company-a:2026-03',
  ]);
 });
 it('scopes the closed-range query by company',async()=>{
  const query=vi.fn(async(sql:string)=>sql.includes('pg_advisory_xact_lock')?{rows:[],rowCount:1}:{rows:[],rowCount:0});
  await expect(assertAccountingRangeWritable('company-b','2026-01-01','2026-03-31',{query} as unknown as PoolClient)).resolves.toBeUndefined();
  expect(query.mock.calls.find(([sql])=>String(sql).includes('monthly_close_periods'))?.[1]).toEqual(['company-b','2026-01-01','2026-03-31']);
 });
});
