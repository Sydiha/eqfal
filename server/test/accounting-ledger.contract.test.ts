import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const router=readFileSync(new URL('../src/modules/accounting/accounting.router.ts',import.meta.url),'utf8');
const posting=readFileSync(new URL('../src/modules/accounting/journal-posting.ts',import.meta.url),'utf8');

describe('Phase 7A1 server accounting contract',()=>{
 it('scopes all approved endpoints through active-company authentication and distinct capabilities',()=>{expect(router).toContain("const base=[requireAuth,requireActiveCompany]");for(const capability of ['accounting.view','accounting.chart.create','accounting.chart.edit','accounting.journal.create','accounting.journal.edit','accounting.journal.post'])expect(router).toContain(`requireCapability('${capability}')`)});
 it('exposes only the minimum account, journal, posting and report API boundary',()=>{for(const route of ["'/accounts'","'/journals'","'/journals/:id'","'/journals/:id/lines'","'/journals/:id/post'","'/trial-balance'","'/general-ledger'"])expect(router).toContain(route);expect(router).not.toMatch(/\.delete\(/i)});
 it('locks the journal transactionally and rejects stale double posting',()=>{expect(posting).toContain('FOR UPDATE');expect(posting).toContain("journal.status !== 'draft'");expect(posting).toContain("AND status='draft' RETURNING")});
 it('requires two balanced lines and active same-company accounts at posting',()=>{expect(posting).toContain('Number(summary.count) < 2');expect(posting).toContain('summary.debit !== summary.credit');expect(posting).toContain('summary.count !== summary.active');expect(posting).toContain('a.company_id=l.company_id')});
 it('validates fiscal-year tenant ownership, date bounds and opening date',()=>{expect(posting).toContain('WHERE id=$1 AND company_id=$2');expect(readFileSync(new URL('../src/modules/accounting/fiscal-year-posting.guard.ts',import.meta.url),'utf8')).toContain('Accounting date must be within the fiscal year');expect(posting).toContain('Opening balance date must equal fiscal year start')});
 it('reuses the shared monthly-close guard for creation, date changes and posting',()=>{expect(router.match(/assertAccountingDateWritable/g)?.length).toBeGreaterThanOrEqual(3);expect(posting).toContain('assertAccountingDateWritable');expect(router).toContain('AccountingPeriodClosedError')});
 it('calculates trial balance and ledger exclusively from posted journals with deterministic activity order',()=>{expect(router).toContain("j.status='posted'");expect(router).toContain('SUM(l.debit-l.credit) OVER');expect(router).toContain('ORDER BY j.accounting_date,j.created_at,j.id,l.sequence,l.id')});
 it('audits account and journal preparation and posting in their transactions',()=>{for(const action of ['account.create','account.update','journal.create','journal.update','journal.lines.replace'])expect(router).toContain(`action:'${action}'`);expect(posting).toContain("action: 'journal.post'")});
});
