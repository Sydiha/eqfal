import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const migration=readFileSync(new URL('../migrations/040_fixed_asset_capability_granularity.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/fixed-assets/fixed-assets.router.ts',import.meta.url),'utf8');
const app=readFileSync(new URL('../../client/src/App.tsx',import.meta.url),'utf8');
const component=readFileSync(new URL('../../client/src/components/FixedAssets.tsx',import.meta.url),'utf8');

describe('Phase 9A.4 fixed-asset capability granularity contract',()=>{
 it('seeds and backfills every granular capability from asset.manage',()=>{
  for(const capability of ['asset.create','asset.edit','asset.cancel','asset.policy.manage'])expect(migration).toContain(`('${capability}')`);
  expect(migration).toContain("WHERE rc.capability_id = 'asset.manage'");
 });
 it('maps fixed-asset routes to exact action capabilities without a broad fallback',()=>{
  for(const capability of ['asset.create','asset.edit','asset.cancel','asset.policy.manage','asset.approve','asset.dispose'])expect(router).toContain(`requireCapability('${capability}')`);
  expect(router).not.toContain("requireCapability('asset.manage')");
 });
 it('keeps frontend capability mapping exact and excludes asset.manage',()=>{
  for(const capability of ['asset.create','asset.edit','asset.cancel','asset.policy.manage','asset.approve','asset.dispose'])expect(app).toContain(`c.includes('${capability}')`);
  expect(app).not.toContain("c.includes('asset.manage')");
  expect(component).not.toContain('canManage:');
 });
});
