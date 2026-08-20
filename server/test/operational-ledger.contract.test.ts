import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const router=readFileSync(new URL('../src/modules/accounting/accounting.router.ts',import.meta.url),'utf8');
const sources=readFileSync(new URL('../src/modules/accounting/operational-sources.ts',import.meta.url),'utf8');
const guards=readFileSync(new URL('../migrations/022_operational_ledger_guards.sql',import.meta.url),'utf8');

describe('Phase 7A2 operational-to-ledger contract',()=>{
 it('exposes the active-company operational source list only through accounting.view',()=>{expect(router).toContain("'/accounting/operational-sources'");expect(router).toMatch(/operational-sources'.*requireCapability\('accounting\.view'\)/);expect(sources).toContain('WHERE company_id=$1')});
 it('allows only approved source types and never direct bank transactions',()=>{for(const type of ['obligation','document_settlement','obligation_settlement','custody_allocation','custody_funding','custody_return'])expect(sources).toContain(`'${type}'`);expect(sources).not.toMatch(/OPERATIONAL_SOURCE_TYPES=.*'bank_transaction'/)});
 it('resolves every source with company identity and validates date and duplicate binding',()=>{expect(sources.match(/company_id=\$2/g)?.length).toBeGreaterThanOrEqual(6);expect(router).toContain('Accounting date must match the operational source');expect(router).toContain('Operational source already has a journal');expect(router).toContain('Operational source identity is immutable')});
 it('re-resolves at manual post and compares NUMERIC amounts without floating point',()=>{expect(router).toContain("$1::numeric(18,2)=$2::numeric(18,2)");expect(router).toContain('Journal total must match the operational source amount');expect(router).not.toContain("status='posted'` INSERT")});
 it('uses document economic date for allocations and excludes missing dates',()=>{expect(sources).toContain('d.document_date::text accounting_date');expect(sources).toContain('d.document_date IS NOT NULL');expect(sources).not.toMatch(/custody_allocation[^`]+created_at/s)});
 it('blocks accounting-material mutations only after posting',()=>{for(const table of ['obligations','document_settlements','obligation_settlements','custody_document_allocations','bank_transaction_matches','bank_transactions'])expect(guards).toContain(`ON ${table}`);expect(guards).toContain("status='posted'");expect(guards).not.toContain("status='draft'")});
});
