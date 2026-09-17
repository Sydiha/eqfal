import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const router=readFileSync(new URL('../src/modules/annual-closing/annual-closing.router.ts',import.meta.url),'utf8');

const routeCapability=(signature:string)=>{
  const index=router.indexOf(signature);
  expect(index).toBeGreaterThanOrEqual(0);
  return router.slice(index,index+900);
};

describe('Annual Close Package action authorization',()=>{
  it('maps package create independently',()=>{
    expect(routeCapability("post('/annual-closing/:fiscalYearId/package'")).toContain("requireCapability('annual_close.package.create')");
  });

  it('maps preview snapshot creation independently',()=>{
    expect(routeCapability("post('/annual-closing/:fiscalYearId/package/snapshots'")).toContain("requireCapability('annual_close.package.snapshot.create')");
  });

  it('retains finalize and handoff as distinct actions',()=>{
    expect(routeCapability("post('/annual-closing/:fiscalYearId/package/finalize'")).toContain("requireCapability('annual_close.package.finalize')");
    expect(routeCapability("post('/annual-closing/:fiscalYearId/package/handoff'")).toContain("requireCapability('annual_close.package.handoff')");
  });
});
