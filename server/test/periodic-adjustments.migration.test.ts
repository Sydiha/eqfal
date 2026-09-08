import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const sql=readFileSync(new URL('../migrations/028_periodic_adjustments.sql',import.meta.url),'utf8');

describe('Phase 4 periodic adjustments migration',()=>{
 it('adds the dedicated capabilities',()=>{
  for(const capability of ['periodic_adjustment.view','periodic_adjustment.manage','periodic_adjustment.review','periodic_adjustment.approve','periodic_adjustment.post'])expect(sql).toContain(`('${capability}')`);
 });
 it('creates the four adjustment types and governed workflow',()=>{
  expect(sql).toContain('CREATE TABLE periodic_adjustments');
  for(const type of ['accrued_expense','prepaid_expense','accrued_income','deferred_income'])expect(sql).toContain(`'${type}'`);
  expect(sql).toContain("workflow_status IN ('draft','in_review','approved','completed')");
 });
 it('uses tenant-safe source and account relationships',()=>{
  expect(sql).toContain('REFERENCES documents(id, company_id)');
  expect(sql).toContain('REFERENCES obligations(id, company_id)');
  expect(sql.match(/REFERENCES accounts\(id, company_id\)/g)).toHaveLength(2);
 });
 it('creates a one-journal-per-schedule-line posting surface',()=>{
  expect(sql).toContain('CREATE TABLE periodic_adjustment_schedule');
  expect(sql).toContain("status IN ('pending','posted')");
  expect(sql).toContain('REFERENCES journal_entries(id, company_id)');
  expect(sql).toContain('periodic_adjustment_schedule_journal_uidx');
 });
});
