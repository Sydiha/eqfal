import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const migration=readFileSync(new URL('../migrations/047_opening_balance_capability_granularity.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/opening-balances/opening-balances.router.ts',import.meta.url),'utf8');

describe('Opening Balance capability granularity contract',()=>{
 it('adds capabilities and backfills legacy roles idempotently without access loss',()=>{
  for(const capability of ['opening_balance.item.create','opening_balance.item.edit','opening_balance.item.delete','opening_balance.submit'])expect(migration).toContain(`'${capability}'`);
  expect(migration).toContain("WHERE rc.capability_id = 'opening_balance.manage'");
  expect(migration).toContain("WHERE rc.capability_id = 'opening_balance.review'");
  expect(migration.match(/ON CONFLICT/g)).toHaveLength(3);
  expect(migration).not.toMatch(/^\s*DELETE\s+FROM|UPDATE\s+role_capabilities/im);
 });

 it('uses only action-specific runtime authorization',()=>{
  for(const capability of ['opening_balance.item.create','opening_balance.item.edit','opening_balance.item.delete','opening_balance.submit','opening_balance.review','opening_balance.approve'])expect(router).toContain(`requireCapability('${capability}')`);
  expect(router).not.toContain("requireCapability('opening_balance.manage')");
 });
});
