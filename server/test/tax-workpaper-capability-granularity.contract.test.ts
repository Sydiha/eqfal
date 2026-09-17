import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration=readFileSync(new URL('../migrations/048_tax_workpaper_capability_granularity.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/tax-working-papers/tax-working-paper.router.ts',import.meta.url),'utf8');

describe('Tax/Zakat working-paper capability granularity contract',()=>{
  const granular=[
    'tax_workpaper.create',
    'tax_workpaper.edit',
    'tax_workpaper.adjustment.create',
    'tax_workpaper.adjustment.edit',
    'tax_workpaper.adjustment.delete',
    'tax_workpaper.submit',
  ] as const;

  it('defines every action-specific capability and backfills legacy manage grants',()=>{
    for(const cap of granular) expect(migration).toContain(`('${cap}')`);
    expect(migration).toContain("WHERE rc.capability_id = 'tax_workpaper.manage'");
  });

  it('uses action-specific runtime authorization with no legacy manage fallback',()=>{
    for(const cap of granular.filter(cap=>cap!=='tax_workpaper.submit')) expect(router).toContain(`requireCapability('${cap}')`);
    expect(router).toContain("['submit-review','tax_workpaper.submit','draft','needs_review']");
    expect(router).not.toContain("requireCapability('tax_workpaper.manage')");
  });

  it('keeps view, review, and approve as independent existing boundaries',()=>{
    expect(router).toContain("requireCapability('tax_workpaper.view')");
    expect(router).toContain("requireCapability('tax_workpaper.review')");
    expect(router).toContain("['review','tax_workpaper.review','needs_review','reviewed']");
    expect(router).toContain("['approve','tax_workpaper.approve','reviewed','approved']");
  });
});
