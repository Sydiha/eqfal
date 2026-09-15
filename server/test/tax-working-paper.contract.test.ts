import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration=readFileSync(new URL('../migrations/035_tax_working_papers.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/tax-working-papers/tax-working-paper.router.ts',import.meta.url),'utf8');
const service=readFileSync(new URL('../src/modules/tax-working-papers/tax-working-paper.service.ts',import.meta.url),'utf8');

describe('Tax/Zakat working-paper contract',()=>{
 it('defines one tenant/year workpaper and company-bound relationships',()=>{expect(migration).toContain('UNIQUE (company_id, fiscal_year_id)');expect(migration).toContain('FOREIGN KEY (fiscal_year_id, company_id)');expect(migration).toContain('FOREIGN KEY (workpaper_id, company_id)');});
 it('uses exact positive amounts without classification heuristics',()=>{expect(migration).toContain('NUMERIC(18,2)');expect(migration).toContain('CHECK (amount > 0)');expect(migration).toContain("direction IN ('add','deduct')");expect(service).not.toMatch(/deductib|expense.*classif/i);});
 it('has independent capability boundaries',()=>{for(const cap of ['tax_workpaper.view','tax_workpaper.manage','tax_workpaper.review','tax_workpaper.approve'])expect(router+migration).toContain(cap);});
 it('fails closed to approved profile applicability and audits changes',()=>{expect(service).toContain("workflow_status='approved'");expect(service).toContain("'needs_review'");expect(service).toContain('AuditLogRepository');expect(service).toContain('before_data:before');expect(service).toContain('after_data:after');});
 it('keeps general mutations draft-only and uses optimistic versions',()=>{expect(service).toContain("workflow_status!=='draft'");expect(service.match(/version=version\+1/g)?.length).toBeGreaterThan(3);expect(service).toContain('FOR UPDATE');});
 it('gives reviewers narrow, tenant-scoped professional-review resolution paths',()=>{expect(router).toMatch(/resolve-professional-review'[\s\S]*requireCapability\('tax_workpaper\.review'\)/);expect(router).toMatch(/adjustments\/:id\/resolve-professional-review'[\s\S]*requireCapability\('tax_workpaper\.review'\)/);expect(service).toContain("workflow_status!=='needs_review'");expect(service).toContain('professional_review_required=FALSE');expect(service).toContain("company_id=$2 AND workflow_status='needs_review' AND professional_review_required=TRUE AND version=$3");expect(service).toContain('tax_workpaper.professional_review.resolve');expect(service).toContain('tax_workpaper.adjustment.professional_review.resolve');});
 it('still blocks review until every professional-review flag is resolved',()=>{expect(service).toContain("to==='reviewed'&&(before.professional_review_required||before.adjustments.some(x=>x.professional_review_required))");expect(service).toContain('Professional review items must be resolved');});
});
