import{readFileSync}from'node:fs';import{describe,expect,it}from'vitest';
const sql=readFileSync(new URL('../migrations/018_obligation_confirm.sql',import.meta.url),'utf8');
describe('Phase 4C confirmation migration',()=>{it('adds only the independent capability without role grants',()=>{expect(sql).toContain("'obligation.confirm'");expect(sql).not.toMatch(/role_capabilities/i)})});
