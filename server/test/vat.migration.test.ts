import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql=readFileSync(new URL('../migrations/020_vat_foundation.sql',import.meta.url),'utf8');

describe('Phase 6A VAT migration',()=>{
 it('adds independent VAT capabilities without role grants',()=>{for(const capability of ['vat.view','vat.review','vat.close','vat.reopen'])expect(sql).toContain(`'${capability}'`);expect(sql).not.toMatch(/role_capabilities/i)});
 it('uses tenant-safe VAT period and document review relationships',()=>{expect(sql).toContain('FOREIGN KEY (fiscal_year_id, company_id)');expect(sql).toContain('FOREIGN KEY (document_id, company_id)');expect(sql).toContain('UNIQUE (id, company_id)')});
 it('prevents overlapping periods and constrains review states and treatments',()=>{expect(sql).toContain('reject_overlapping_vat_periods');expect(sql).toContain("review_status IN ('pending', 'reviewed')");for(const value of ['standard','zero_rated','exempt','out_of_scope'])expect(sql).toContain(`'${value}'`)});
});
