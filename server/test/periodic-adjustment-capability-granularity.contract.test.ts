import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const migration=readFileSync(new URL('../migrations/043_periodic_adjustment_capability_granularity.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/periodic-adjustments/periodic-adjustments.router.ts',import.meta.url),'utf8');

describe('Periodic Adjustments capability granularity contract',()=>{
 it('idempotently seeds and backfills the exact action capabilities',()=>{
  for(const capability of ['create','edit','submit'])expect(migration).toContain(`'periodic_adjustment.${capability}'`);
  expect(migration).toContain("WHERE rc.capability_id = 'periodic_adjustment.manage'");
  expect(migration).toContain("WHERE rc.capability_id = 'periodic_adjustment.review'");
  expect(migration.match(/ON CONFLICT/g)).toHaveLength(3);
  expect(migration).not.toMatch(/DELETE|UPDATE/i);
 });

 it('maps corrected routes without a legacy manage fallback',()=>{
  expect(router).toContain("requireCapability('periodic_adjustment.create')");
  expect(router).toContain("requireCapability('periodic_adjustment.edit')");
  expect(router).toContain("requireCapability('periodic_adjustment.submit')");
  expect(router).not.toContain("requireCapability('periodic_adjustment.manage')");
 });
});
