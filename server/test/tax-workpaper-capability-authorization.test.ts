import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const router=readFileSync(new URL('../src/modules/tax-working-papers/tax-working-paper.router.ts',import.meta.url),'utf8');

const routeCapability=(signature:string)=>{
  const index=router.indexOf(signature);
  expect(index).toBeGreaterThanOrEqual(0);
  return router.slice(index,index+700);
};

describe('Tax/Zakat working-paper action authorization',()=>{
  it('maps create and edit to separate capabilities',()=>{
    expect(routeCapability("post('/tax-working-papers/:fiscalYearId'")).toContain("requireCapability('tax_workpaper.create')");
    expect(routeCapability("patch('/tax-working-papers/:fiscalYearId'")).toContain("requireCapability('tax_workpaper.edit')");
  });

  it('maps adjustment CRUD to separate capabilities',()=>{
    expect(routeCapability("post('/tax-working-papers/:fiscalYearId/adjustments'")).toContain("requireCapability('tax_workpaper.adjustment.create')");
    expect(routeCapability("patch('/tax-working-papers/:fiscalYearId/adjustments/:id'")).toContain("requireCapability('tax_workpaper.adjustment.edit')");
    expect(routeCapability("delete('/tax-working-papers/:fiscalYearId/adjustments/:id'")).toContain("requireCapability('tax_workpaper.adjustment.delete')");
  });

  it('maps submit, review, and approve independently',()=>{
    expect(router).toContain("['submit-review','tax_workpaper.submit','draft','needs_review']");
    expect(router).toContain("['review','tax_workpaper.review','needs_review','reviewed']");
    expect(router).toContain("['approve','tax_workpaper.approve','reviewed','approved']");
  });
});
