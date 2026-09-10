import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql=readFileSync(new URL('../migrations/020_vat_foundation.sql',import.meta.url),'utf8');

describe('Phase 6A VAT migration',()=>{
 it('adds independent VAT capabilities without role grants',()=>{for(const capability of ['vat.view','vat.review','vat.close','vat.reopen'])expect(sql).toContain(`'${capability}'`);expect(sql).not.toMatch(/role_capabilities/i)});
 it('uses tenant-safe VAT period and document review relationships',()=>{expect(sql).toContain('FOREIGN KEY (fiscal_year_id, company_id)');expect(sql).toContain('FOREIGN KEY (document_id, company_id)');expect(sql).toContain('UNIQUE (id, company_id)')});
 it('prevents overlapping periods and constrains review states and treatments',()=>{expect(sql).toContain('reject_overlapping_vat_periods');expect(sql).toContain("review_status IN ('pending', 'reviewed')");for(const value of ['standard','zero_rated','exempt','out_of_scope'])expect(sql).toContain(`'${value}'`)});
});

const recoverabilitySql=readFileSync(new URL('../migrations/029_vat_recoverability.sql',import.meta.url),'utf8');
describe('Phase 6B2 VAT recoverability migration',()=>{
 it('uses the next migration and constrains the approved states and money bounds',()=>{for(const state of ['not_applicable','fully_recoverable','non_recoverable','partially_recoverable','needs_review'])expect(recoverabilitySql).toContain(`'${state}'`);expect(recoverabilitySql).toContain('NUMERIC(18,2)');expect(recoverabilitySql).toContain('recoverable_vat_amount >= 0');expect(recoverabilitySql).toContain('recoverable_vat_amount <= vat_amount')});
 it('backfills historical rows deterministically without fabricating approval',()=>{expect(recoverabilitySql).toContain("d.document_type = 'sale' THEN 'not_applicable'");expect(recoverabilitySql).toContain("ELSE 'needs_review'");expect(recoverabilitySql).not.toMatch(/recoverability_reviewed_by_user_id\s*=/);expect(recoverabilitySql).not.toMatch(/recoverability_reviewed_at\s*=/)});
 it('retains tenant-safe document matching and user foreign keys',()=>{expect(recoverabilitySql).toContain('d.company_id = r.company_id');expect(recoverabilitySql).toContain('REFERENCES users(id)')});
});
