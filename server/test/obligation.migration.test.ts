import {readFileSync} from 'node:fs';import{describe,expect,it}from'vitest';
const raw=readFileSync(new URL('../migrations/017_counterparties_obligations.sql',import.meta.url),'utf8');
const sql=raw.replace(/\s+/g,' ').trim();
describe('Phase 4B schema integrity (whitespace-insensitive)',()=>{
 it('adds capabilities without granting roles',()=>{for(const c of ['obligation.view','obligation.manage','obligation.settle'])expect(sql).toContain(c);expect(sql).not.toMatch(/role_capabilities/i)});
 it('creates tenant-scoped counterparties, obligations, and settlements',()=>{for(const table of ['counterparties','obligations','obligation_settlements'])expect(sql).toContain(`CREATE TABLE ${table}`);expect(sql.match(/UNIQUE\s*\(\s*id\s*,\s*company_id\s*\)/gi)).toHaveLength(3)});
 it('uses exact money and validates dates, sources, and versions',()=>{expect(sql.match(/NUMERIC\s*\(\s*18\s*,\s*2\s*\)/gi)).toHaveLength(2);expect(sql).toMatch(/due_on\s+IS\s+NULL\s+OR\s+due_on\s*>=\s*recognized_on/i);expect(sql).toContain("source_type IN ('document','opening_balance','manual')");expect(sql.match(/version INTEGER NOT NULL DEFAULT 1 CHECK\s*\(\s*version\s*>\s*0\s*\)/gi)).toHaveLength(2)});
 it('enforces composite tenant relationships and preserves free text',()=>{for(const relation of ['counterparties','documents','obligations','bank_transactions'])expect(sql).toMatch(new RegExp(`REFERENCES ${relation}\\s*\\(\\s*id\\s*,\\s*company_id\\s*\\)`,'i'));expect(sql).toContain('ALTER TABLE documents ADD COLUMN counterparty_id');expect(sql).not.toMatch(/DROP COLUMN counterparty_name/i)});
 it('prevents duplicate document obligations',()=>expect(sql).toMatch(/UNIQUE INDEX obligations_one_document_idx ON obligations\s*\(\s*document_id\s*\) WHERE source_type\s*=\s*'document'/i));
 it('guards single explanation across all three relationship tables',()=>{expect(sql).toContain('obligation_settlement_explanation_guard');expect(sql).toContain('document_settlement_obligation_guard');expect(sql).toContain('bank_match_obligation_guard');for(const table of ['bank_transaction_matches','document_settlements','obligation_settlements'])expect(sql).toContain(`FROM ${table}`)});
});
