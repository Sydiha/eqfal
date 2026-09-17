import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration=readFileSync(new URL('../migrations/049_annual_close_package_capability_granularity.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/annual-closing/annual-closing.router.ts',import.meta.url),'utf8');

describe('Annual Close Package capability granularity contract',()=>{
  const granular=['annual_close.package.create','annual_close.package.snapshot.create'] as const;

  it('defines granular package capabilities and backfills legacy manage grants',()=>{
    for(const cap of granular) expect(migration).toContain(`('${cap}')`);
    expect(migration).toContain("WHERE rc.capability_id = 'annual_close.package.manage'");
  });

  it('uses granular runtime authorization with no legacy manage fallback',()=>{
    expect(router).toContain("requireCapability('annual_close.package.create')");
    expect(router).toContain("requireCapability('annual_close.package.snapshot.create')");
    expect(router).not.toContain("requireCapability('annual_close.package.manage')");
  });

  it('keeps view, finalize, and handoff as independent existing boundaries',()=>{
    expect(router).toContain("requireCapability('annual_close.package.view')");
    expect(router).toContain("requireCapability('annual_close.package.finalize')");
    expect(router).toContain("requireCapability('annual_close.package.handoff')");
  });
});
