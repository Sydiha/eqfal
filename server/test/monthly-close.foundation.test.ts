import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { AccountingPeriodClosedError, assertAccountingDateWritable, lockAccountingRange } from '../src/modules/monthly-close/accounting-period.guard';

const migration=readFileSync(new URL('../migrations/019_monthly_close_periods.sql',import.meta.url),'utf8').replace(/\s+/g,' ');
const router=readFileSync(new URL('../src/modules/monthly-close/monthly-close.router.ts',import.meta.url),'utf8').replace(/\s+/g,' ');
const obligation=readFileSync(new URL('../src/modules/obligations/obligation.router.ts',import.meta.url),'utf8');
const documents=readFileSync(new URL('../src/modules/documents/document.service.ts',import.meta.url),'utf8');
const banking=['bank.router.ts','bank-reconciliation.router.ts','document-settlement.router.ts','custody.router.ts'].map(name=>readFileSync(new URL(`../src/modules/banking/${name}`,import.meta.url),'utf8')).join('\n');

describe('monthly close schema and API contract',()=>{
 it('stores only open and closed tenant-scoped periods linked to tenant fiscal years',()=>{expect(migration).toContain('CREATE TABLE monthly_close_periods');expect(migration).toContain("CHECK (status IN ('open', 'closed'))");expect(migration).toMatch(/FOREIGN KEY \(fiscal_year_id, company_id\) REFERENCES fiscal_years\(id, company_id\)/);expect(migration).not.toMatch(/draft|ready|closing|reopened/);});
 it('adds exactly the independent close and reopen capabilities without role grants',()=>{expect(migration.match(/monthly_close\.[a-z]+/g)).toEqual(['monthly_close.close','monthly_close.reopen']);expect(migration).not.toMatch(/role_capabilities|monthly_close\.manage/);});
 it('exposes only the approved monthly close routes',()=>{expect(router.match(/monthlyCloseRouter\.(?:get|post|patch|delete)\('[^']+'/g)).toEqual(["monthlyCloseRouter.get('/monthly-close-periods'","monthlyCloseRouter.post('/monthly-close-periods'","monthlyCloseRouter.post('/monthly-close-periods/:id/close'","monthlyCloseRouter.post('/monthly-close-periods/:id/reopen'"]);});
 it('scopes period transitions by company and locks rows',()=>{expect(router.match(/WHERE id=\$1 AND company_id=\$2 FOR UPDATE/g)).toHaveLength(2);expect(router).not.toMatch(/monthly_close_periods WHERE id=\$1 FOR UPDATE/);});
 it('validates fiscal-year ownership, boundaries, and overlap before create',()=>{expect(router).toContain('FROM fiscal_years WHERE id=$1 AND company_id=$2');expect(router).toContain('start<fy.start_date||end>fy.end_date');expect(router).toContain('period_start<=$3 AND period_end>=$2');});
 it('requires separate close/reopen capabilities and a bounded non-empty reason',()=>{expect(router).toContain("requireCapability('monthly_close.close')");expect(router).toContain("requireCapability('monthly_close.reopen')");expect(router).toContain('reason.length<=500');});
});

describe('readiness and closed-period write contract',()=>{
 it('uses only approved document, obligation, and unresolved-bank blockers',()=>{expect(router).toContain("status IN ('uploaded','needs_review','incomplete')");expect(router).toContain("NOT is_cancelled AND verification_status='unconfirmed'");for(const table of ['bank_transaction_matches','document_settlements','obligation_settlements'])expect(router).toContain(`NOT EXISTS(SELECT 1 FROM ${table}`);expect(router).not.toMatch(/custody_advances.*COUNT|partially|settled_amount/);});
 it('keeps confirmed open/partial obligations and open custody out of blockers',()=>{expect(router).not.toContain("verification_status='confirmed'");expect(router).not.toContain('custody_advances');});
 it('wires the centralized guard into documents, obligations, settlements, banking, and custody',()=>{expect(documents).toContain('assertAccountingDateWritable');expect(obligation.match(/assertAccountingDateWritable/g)!.length).toBeGreaterThanOrEqual(5);expect(banking.match(/assertAccountingDateWritable/g)!.length).toBeGreaterThanOrEqual(10);});
 it('guards both the old and new document dates when a date changes',()=>{expect(documents).toContain("current.document_date !== accountingDate");});
});

describe('accounting period concurrency guard',()=>{
 it('locks every touched company/month in stable order',async()=>{const query=vi.fn().mockResolvedValue({rows:[],rowCount:0});await lockAccountingRange('company','2026-01-15','2026-03-02',{query} as unknown as PoolClient);expect(query.mock.calls.map(call=>call[1])).toEqual([['accounting-period:company:2026-01'],['accounting-period:company:2026-02'],['accounting-period:company:2026-03']]);});
 it('checks closed state only after taking the same transaction lock',async()=>{const query=vi.fn().mockResolvedValueOnce({rows:[],rowCount:1}).mockResolvedValueOnce({rows:[{exists:1}],rowCount:1});await expect(assertAccountingDateWritable('company','2026-01-20',{query} as unknown as PoolClient)).rejects.toBeInstanceOf(AccountingPeriodClosedError);expect(String(query.mock.calls[0]![0])).toContain('pg_advisory_xact_lock');expect(String(query.mock.calls[1]![0])).toContain("status='closed'");});
 it('allows the equivalent write when no closed period contains the date',async()=>{const query=vi.fn().mockResolvedValue({rows:[],rowCount:0});await expect(assertAccountingDateWritable('company','2026-02-01',{query} as unknown as PoolClient)).resolves.toBeUndefined();});
 it('makes close use the same range lock before blockers and transition',()=>{expect(router).toContain('lockAccountingRange(companyId,period.period_start,period.period_end,client);const blockers=await this.blockers');});
});

describe('atomic audit transitions',()=>{
 it('records create, close, and reopen in their business transactions',()=>{for(const event of ['monthly_close.create','monthly_close.close','monthly_close.reopen'])expect(router).toContain(`action:'${event}'`);expect(router).toContain("before_data:{status:'open'},after_data:{status:'closed'}");expect(router).toContain("before_data:{status:'closed'},after_data:{status:'open'},reason");});
});
