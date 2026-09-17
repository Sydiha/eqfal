import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const migration=readFileSync(new URL('../migrations/051_fixed_asset_estimate_change_governance.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/fixed-assets/asset-estimate-change.router.ts',import.meta.url),'utf8');
const app=readFileSync(new URL('../src/app.ts',import.meta.url),'utf8');

describe('Phase 2A.2 governed prospective asset estimate changes',()=>{
 it('creates an auditable lifecycle with granular capabilities',()=>{
  expect(migration).toContain('CREATE TABLE asset_estimate_changes');
  for(const token of ["'asset.estimate_change.create'","'asset.estimate_change.review'","'asset.estimate_change.approve'","status IN ('draft','reviewed','approved')",'reviewed_by','approved_by','policy_exception'])expect(migration).toContain(token);
  expect(migration).toContain('asset_estimate_change_open_uidx');
  expect(migration).toContain('asset_estimate_change_approved_effective_uidx');
 });
 it('protects approved asset estimate fields from direct mutation',()=>{
  expect(migration).toContain('guard_fixed_asset_estimate_fields');
  expect(migration).toContain("current_setting('eqfal.asset_estimate_change',true)");
  expect(migration).toContain('Approved fixed-asset estimates must be changed through governed estimate-change workflow');
 });
 it('enforces prospective monthly effective dates and preserves posted depreciation',()=>{
  expect(router).toContain("x.effective_from.slice(8,10)!=='01'");
  expect(router).toContain('assertAccountingDateWritable(companyId,input.effectiveFrom,c)');
  expect(router).toContain("status='posted' AND period_end>=$3");
  expect(router).toContain("status='posted' AND period_end<$3");
  expect(router).toContain("DELETE FROM asset_depreciation_entries WHERE company_id=$1 AND asset_id=$2 AND status='pending' AND period_start>=$3");
  expect(router).toContain('buildProspectiveSchedule');
  expect(router).toContain('Residual value cannot exceed net book value at the effective date');
 });
 it('requires explicit policy-exception reasoning when category policy is contradicted',()=>{
  expect(router).toContain("p.useful_life_mode==='fixed'");
  expect(router).toContain("p.residual_value_policy==='zero'");
  expect(router).toContain('Policy exception reason is required');
  expect(router).toContain('policy_exception_reason');
 });
 it('exposes governed create, edit, review, approval and audit routes',()=>{
  for(const path of ["'/assets/:id/estimate-changes'","'/asset-estimate-changes/:id'","'/asset-estimate-changes/:id/review'","'/asset-estimate-changes/:id/approve'"])expect(router).toContain(path);
  expect(router).toContain("requireCapability('asset.estimate_change.create')");
  expect(router).toContain("requireCapability('asset.estimate_change.review')");
  expect(router).toContain("requireCapability('asset.estimate_change.approve')");
  for(const action of ["action:'asset.estimate_change.create'","action:'asset.estimate_change.update'","action:'asset.estimate_change.review'","action:'asset.estimate_change.schedule_rebuild'","action:'asset.estimate_change.approve'"])expect(router).toContain(action);
  expect(app).toContain("app.use('/api', assetEstimateChangeRouter)");
 });
 it('keeps the scope to active assets and blocks reviewed request mutation',()=>{
  expect(router).toContain("asset.status!=='active'");
  expect(router).toContain('Only active assets support estimate changes');
  expect(router).toContain("before.status!=='draft'");
  expect(router).toContain('Reviewed estimate change is immutable');
 });
});
