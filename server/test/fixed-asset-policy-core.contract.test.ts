import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const migration=readFileSync(new URL('../migrations/050_fixed_asset_depreciation_policy_core.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/fixed-assets/asset-policy.router.ts',import.meta.url),'utf8');
const app=readFileSync(new URL('../src/app.ts',import.meta.url),'utf8');
const sources=readFileSync(new URL('../src/modules/accounting/operational-sources.ts',import.meta.url),'utf8');

describe('Phase 2A.1 versioned fixed-asset depreciation policy core',()=>{
 it('creates dated policy versions with governed lifecycle and historical asset binding',()=>{
  expect(migration).toContain('CREATE TABLE asset_category_depreciation_policies');
  for(const token of ['effective_from','version_number',"status IN ('draft','approved','superseded')",'reviewed_by','approved_by','depreciation_policy_version_id'])expect(migration).toContain(token);
  expect(migration).toContain('asset_category_one_approved_policy_uidx');
  expect(migration).toContain('fixed_asset_policy_binding_guard');
  expect(migration).toContain("status IN ('approved','superseded')");
 });
 it('protects category policy fields from the legacy direct-edit path',()=>{
  expect(migration).toContain('guard_asset_category_policy_columns');
  expect(migration).toContain("current_setting('eqfal.asset_policy_sync',true)");
  expect(migration).toContain("ERRCODE='23514'");
 });
 it('exposes create, edit, review and approval through asset.policy.manage',()=>{
  for(const path of ["'/asset-categories/:id/policies'","'/asset-policies/:id'","'/asset-policies/:id/review'","'/asset-policies/:id/approve'"])expect(router).toContain(path);
  expect(router.match(/requireCapability\('asset\.policy\.manage'\)/g)?.length).toBe(4);
  expect(router).toContain('New policy effective date must be later than current approved policy');
  expect(router).toContain("action:'asset.policy.supersede'");
  expect(router).toContain("action:'asset.policy.approve'");
  expect(app).toContain("app.use('/api', assetPolicyRouter)");
 });
 it('uses the policy-version account snapshot for later depreciation and disposal sources',()=>{
  expect(sources).toContain('LEFT JOIN asset_category_depreciation_policies p');
  expect(sources).toContain("'depreciation_policy_version_id',a.depreciation_policy_version_id");
  expect(sources).toContain('COALESCE(p.depreciation_expense_account_id,c.depreciation_expense_account_id)');
  expect(sources).toContain('COALESCE(p.accumulated_depreciation_account_id,c.accumulated_depreciation_account_id)');
 });
});
