import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const migration=readFileSync(new URL('../migrations/041_accounting_capability_granularity.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/accounting/accounting.router.ts',import.meta.url),'utf8');
const classificationRouter=readFileSync(new URL('../src/modules/accounting/account-classification.router.ts',import.meta.url),'utf8');
const app=readFileSync(new URL('../../client/src/App.tsx',import.meta.url),'utf8');
const component=readFileSync(new URL('../../client/src/components/AccountingCore.tsx',import.meta.url),'utf8');

const capabilities=['accounting.chart.create','accounting.chart.edit','accounting.journal.create','accounting.journal.edit'] as const;

describe('Phase 9A.5 accounting capability granularity contract',()=>{
 it('idempotently seeds and backfills the exact capabilities from each legacy grant',()=>{
  for(const capability of capabilities)expect(migration).toContain(`('${capability}')`);
  expect(migration.match(/ON CONFLICT \(role_id, capability_id\) DO NOTHING/g)).toHaveLength(2);
  expect(migration).toContain("WHERE rc.capability_id = 'accounting.chart.manage'");
  expect(migration).toContain("WHERE rc.capability_id = 'accounting.journal.manage'");
 });
 it('authorizes every accounting mutation with its exact action capability',()=>{
  expect(router).toContain("post('/accounts',requireSameOrigin,...base,requireCapability('accounting.chart.create')");
  expect(router).toContain("patch('/accounts/:id',requireSameOrigin,...base,requireCapability('accounting.chart.edit')");
  expect(router).toContain("post('/journals',requireSameOrigin,...base,requireCapability('accounting.journal.create')");
  expect(router).toContain("patch('/journals/:id',requireSameOrigin,...base,requireCapability('accounting.journal.edit')");
  expect(router).toContain("put('/journals/:id/lines',requireSameOrigin,...base,requireCapability('accounting.journal.edit')");
  expect(classificationRouter).toContain("requireCapability('accounting.chart.edit')");
 });
 it('retains read and posting authority without broad runtime fallbacks',()=>{
  expect(router).toContain("requireCapability('accounting.view')");
  expect(router).toContain("requireCapability('accounting.journal.post')");
  expect(router).not.toContain("requireCapability('accounting.chart.manage')");
  expect(router).not.toContain("requireCapability('accounting.journal.manage')");
  expect(classificationRouter).not.toContain("requireCapability('accounting.chart.manage')");
 });
 it('maps frontend controls one-to-one without broad capability fallbacks',()=>{
  for(const capability of capabilities)expect(app).toContain(`c.includes('${capability}')`);
  expect(app).not.toContain("c.includes('accounting.chart.manage')");
  expect(app).not.toContain("c.includes('accounting.journal.manage')");
  for(const permission of ['canCreateChart','canEditChart','canCreateJournal','canEditJournal'])expect(component).toContain(permission);
 });
});
