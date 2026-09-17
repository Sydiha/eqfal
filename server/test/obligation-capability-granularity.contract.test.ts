import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const migration=readFileSync(new URL('../migrations/045_obligation_counterparty_capability_granularity.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/obligations/obligation.router.ts',import.meta.url),'utf8');
const app=readFileSync(new URL('../../client/src/App.tsx',import.meta.url),'utf8');
const component=readFileSync(new URL('../../client/src/components/Obligations.tsx',import.meta.url),'utf8');
const management=['counterparty.create','counterparty.edit','counterparty.disable','obligation.create','obligation.edit','obligation.cancel'];
const settlement=['obligation.settlement.create','obligation.settlement.remove'];

describe('Wave A / A2 capability granularity contract',()=>{
 it('adds every capability and idempotently backfills the exact legacy groups',()=>{
  for(const capability of [...management,...settlement])expect(migration).toContain(`('${capability}')`);
  expect(migration).toContain("WHERE rc.capability_id = 'obligation.manage'");
  expect(migration).toContain("WHERE rc.capability_id = 'obligation.settle'");
  expect(migration.match(/ON CONFLICT \(role_id, capability_id\) DO NOTHING;/g)).toHaveLength(2);
  expect(migration).not.toMatch(/DELETE|UPDATE\s+role_capabilities/i);
 });
 it('uses granular runtime authorization and no legacy fallback in the A2 router',()=>{
  for(const capability of [...management,...settlement,'obligation.confirm'])expect(router).toContain(`'${capability}'`);
  expect(router).not.toContain("requireCapability('obligation.manage')");
  expect(router).not.toContain("requireCapability('obligation.settle')");
 });
 it('maps and gates every frontend action independently',()=>{
  for(const capability of [...management,...settlement,'obligation.confirm'])expect(app).toContain(`c.includes('${capability}')`);
  expect(component).not.toContain('canManage');
  expect(component).not.toContain('canSettle');
 });
});
