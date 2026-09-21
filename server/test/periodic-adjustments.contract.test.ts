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
 it('keeps periodic schedule posting workflow-owned while exposing its source to shared posting validation',()=>{
  expect(sources).toContain("JournalOperationalSourceType=OperationalSourceType|'periodic_adjustment'");
  expect(sources).toContain("periodic_adjustment:`SELECT 'periodic_adjustment'");
  expect(sources).toContain("s.status='pending'");
  expect(sources).toContain("a.workflow_status='approved'");
  expect(sources).not.toContain("OPERATIONAL_SOURCE_TYPES=['obligation','document_settlement','obligation_settlement','custody_allocation','custody_funding','custody_return','asset_depreciation','asset_disposal','periodic_adjustment']");
 });
 it('enforces the configured account mapping before a periodic journal can post',()=>{
  expect(posting).toContain("type !== 'periodic_adjustment'");
  expect(posting).toContain("journal.source_type === 'periodic_adjustment'");
  expect(posting).toContain('balance_account_id');
  expect(posting).toContain('pnl_account_id');
  expect(posting).toContain('Periodic adjustment journal must use the configured balance-sheet and P&L accounts');
 });
 it('blocks monthly close for unresolved or due periodic adjustments',()=>{
  expect(close).toContain("a.workflow_status IN ('draft','in_review')");
  expect(close).toContain("a.workflow_status='approved' AND s.status='pending'");
  expect(close).toContain('periodic_adjustments=Number(rows[0]!.periodic_adjustments)');
  expect(close).toContain('total:documents+obligations+bank_transactions+vat+ledger+assets+opening_balances+periodic_adjustments');
  expect(close).not.toContain('independentDrafts+periodicAdjustments');
 });
 it('requires a reason to return an in-review adjustment to draft',()=>{
  expect(router).toContain("'/periodic-adjustments/:id/return-to-draft'");
  expect(router).toContain("throw new Invalid('Reason is required')");
  expect(router).toContain("action:'periodic_adjustment.return_to_draft'");
 });
 it('blocks future periodic-adjustment schedule posting before journal creation',()=>{
  const futureGuard="if(s.recognition_date>today)throw new Conflict('Periodic adjustment recognition date is in the future')";
  expect(router).toContain('SELECT CURRENT_DATE::text AS today');
  expect(router).toContain(futureGuard);
  expect(router.indexOf(futureGuard)).toBeLessThan(router.indexOf('INSERT INTO journal_entries'));
  expect(router).toContain("if(s.status!=='pending'||s.journal_entry_id)throw new Conflict('Schedule line is already posted')");
  expect(router.indexOf('assertAccountingDateWritable(company,s.recognition_date,c)')).toBeLessThan(router.indexOf('INSERT INTO journal_entries'));
 });
 it('uses an unambiguous typed schedule list projection',()=>{
  expect(router).toContain('FROM periodic_adjustment_schedule s WHERE s.company_id=$1 ORDER BY s.recognition_date,s.id');
  expect(router).toContain('s.recognition_date::text AS recognition_date');
  expect(router).not.toContain('FROM periodic_adjustment_schedule WHERE company_id=$1 ORDER BY recognition_date,id');
 });
});
