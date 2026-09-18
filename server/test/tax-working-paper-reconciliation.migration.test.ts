import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql=readFileSync(new URL('../migrations/053_tax_workpaper_reconciliation.sql',import.meta.url),'utf8');
describe('tax workpaper reconciliation migration',()=>{it('adds nullable, all-or-none durable source evidence without rewriting existing rows',()=>{expect(sql).toContain('starting_financial_base NUMERIC(18,2)');expect(sql).toContain('source_fingerprint TEXT');expect(sql).toContain('source_reconciled_at TIMESTAMPTZ');expect(sql).toContain('tax_workpaper_reconciliation_evidence_complete');expect(sql).not.toMatch(/UPDATE tax_working_papers|DROP /);});});
