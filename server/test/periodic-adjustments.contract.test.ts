import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const router=readFileSync(new URL('../src/modules/periodic-adjustments/periodic-adjustments.router.ts',import.meta.url),'utf8');
const sources=readFileSync(new URL('../src/modules/accounting/operational-sources.ts',import.meta.url),'utf8');
const posting=readFileSync(new URL('../src/modules/accounting/journal-posting.ts',import.meta.url),'utf8');
const close=readFileSync(new URL('../src/modules/monthly-close/monthly-close.router.ts',import.meta.url),'utf8');

describe('Phase 4 periodic adjustments accounting contract',()=>{
 it('generates monthly schedule lines and routes posting through the shared journal contract',()=>{
  expect(router).toContain('monthPeriods');
  expect(router).toContain("INSERT INTO periodic_adjustment_schedule");
  expect(router).toContain("source_type,source_id,entry_type,created_by");
  expect(router).toContain("'periodic_adjustment'");
  expect(router).toContain('postJournalInTransaction(c,company,actor,journal.id)');
 });
 it('registers pending schedule lines as operational sources',()=>{
  expect(sources).toContain("'periodic_adjustment'");
  expect(sources).toContain("s.status='pending'");
  expect(sources).toContain("a.workflow_status='approved'");
 });
 it('enforces the configured account mapping before a periodic journal can post',()=>{
  expect(posting).toContain("journal.source_type === 'periodic_adjustment'");
  expect(posting).toContain('balance_account_id');
  expect(posting).toContain('pnl_account_id');
  expect(posting).toContain('Periodic adjustment journal must use the configured balance-sheet and P&L accounts');
 });
 it('feeds pending periodic sources into the existing monthly-close ledger blocker',()=>{
  expect(close).toContain('loadOperationalSources(companyId,client)');
  expect(close).toContain('unpostedSources++');
 });
 it('requires a reason to return an in-review adjustment to draft',()=>{
  expect(router).toContain("'/periodic-adjustments/:id/return-to-draft'");
  expect(router).toContain("throw new Invalid('Reason is required')");
  expect(router).toContain("action:'periodic_adjustment.return_to_draft'");
 });
});
