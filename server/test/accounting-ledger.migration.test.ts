import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql=readFileSync(new URL('../migrations/021_accounting_ledger_foundation.sql',import.meta.url),'utf8');

describe('Phase 7A1 accounting ledger migration',()=>{
 it('introduces four independent capabilities without automatically granting them',()=>{for(const capability of ['accounting.view','accounting.chart.manage','accounting.journal.manage','accounting.journal.post'])expect(sql).toContain(`'${capability}'`);expect(sql).not.toMatch(/INSERT INTO role_capabilities/i)});
 it('limits account types and journal lifecycle to the approved values',()=>{expect(sql).toContain("account_type IN ('asset','liability','equity','revenue','expense')");expect(sql).toContain("status IN ('draft','posted')");expect(sql).toContain("entry_type IN ('standard','opening_balance')")});
 it('makes account codes company-scoped and permits the same code in another company',()=>{expect(sql).toContain('UNIQUE (company_id, code)');expect(sql).not.toContain('code TEXT UNIQUE')});
 it('uses composite tenant-safe relationships for parents, fiscal years, entries and accounts',()=>{for(const relationship of ['FOREIGN KEY (parent_account_id, company_id)','FOREIGN KEY (fiscal_year_id, company_id)','FOREIGN KEY (journal_entry_id, company_id)','FOREIGN KEY (account_id, company_id)'])expect(sql).toContain(relationship)});
 it('prevents self-parenting and invalid debit/credit values in PostgreSQL',()=>{expect(sql).toContain('parent_account_id <> id');expect(sql).toContain('debit >= 0 AND credit >= 0');expect(sql).toContain("(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)")});
 it('uses exact repository money precision and deterministic line sequence',()=>{expect(sql).toContain('NUMERIC(18,2)');expect(sql).toContain('UNIQUE (journal_entry_id, sequence)')});
 it('protects posted entries and their lines from ordinary mutation',()=>{expect(sql).toContain('journal_entries_posted_immutable');expect(sql).toContain('journal_lines_posted_immutable');expect(sql).toContain("OLD.status = 'posted'")});
 it('makes optional explicit source identities tenant-scoped and duplicate-safe',()=>{expect(sql).toContain('journal_entries_source_uidx');expect(sql).toContain('(company_id, source_type, source_id)');expect(sql).toContain('(source_type IS NULL) = (source_id IS NULL)')});
});
