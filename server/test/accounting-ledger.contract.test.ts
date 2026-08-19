import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source=readFileSync(new URL('../src/modules/accounting/accounting.router.ts',import.meta.url),'utf8');

describe('Phase 7A1 server accounting contract',()=>{
 it('scopes all approved endpoints through active-company authentication and distinct capabilities',()=>{expect(source).toContain("const base=[requireAuth,requireActiveCompany]");for(const capability of ['accounting.view','accounting.chart.manage','accounting.journal.manage','accounting.journal.post'])expect(source).toContain(`requireCapability('${capability}')`)});
 it('exposes only the minimum account, journal, posting and report API boundary',()=>{for(const route of ["'/accounts'","'/journals'","'/journals/:id'","'/journals/:id/lines'","'/journals/:id/post'","'/trial-balance'","'/general-ledger'"])expect(source).toContain(route);expect(source).not.toMatch(/\.delete\(/i)});
 it('locks the journal transactionally and rejects stale double posting',()=>{expect(source).toContain('FOR UPDATE');expect(source).toContain("journal.status!=='draft'");expect(source).toContain("AND status='draft' RETURNING")});
 it('requires two balanced lines and active same-company accounts at posting',()=>{expect(source).toContain('Number(summary.count)<2');expect(source).toContain('summary.debit!==summary.credit');expect(source).toContain('summary.count!==summary.active');expect(source).toContain('a.company_id=l.company_id')});
 it('validates fiscal-year tenant ownership, date bounds and opening date',()=>{expect(source).toContain('WHERE id=$1 AND company_id=$2');expect(source).toContain('Accounting date must be within the fiscal year');expect(source).toContain('Opening balance date must equal fiscal year start')});
 it('reuses the shared monthly-close guard for creation, date changes and posting',()=>{expect(source.match(/assertAccountingDateWritable/g)?.length).toBeGreaterThanOrEqual(4);expect(source).toContain('AccountingPeriodClosedError')});
 it('calculates trial balance and ledger exclusively from posted journals with deterministic activity order',()=>{expect(source).toContain("j.status='posted'");expect(source).toContain('SUM(l.debit-l.credit) OVER');expect(source).toContain('ORDER BY j.accounting_date,j.created_at,j.id,l.sequence,l.id')});
 it('audits account and journal preparation and posting in their transactions',()=>{for(const action of ['account.create','account.update','journal.create','journal.update','journal.lines.replace','journal.post'])expect(source).toContain(`action:'${action}'`)});
});
