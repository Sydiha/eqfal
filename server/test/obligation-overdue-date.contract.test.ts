import{readFileSync}from'node:fs';
import{describe,expect,it}from'vitest';

describe('obligation overdue operational date contract',()=>{
 it('uses the shared Riyadh operational date instead of UTC date slicing',()=>{
  const source=readFileSync(new URL('../src/modules/obligations/obligation.router.ts',import.meta.url),'utf8');
  expect(source).toContain("import {operationalDate} from '../../operational-date';");
  expect(source).toContain('const today=operationalDate();');
  expect(source).toContain('o.due_on<today');
  expect(source).not.toContain("new Date().toISOString().slice(0,10)");
 });
});
