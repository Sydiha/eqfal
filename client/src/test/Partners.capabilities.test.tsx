import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app=readFileSync('src/App.tsx','utf8');

describe('Partners App capability mapping',()=>{
 it('maps every action flag to its granular capability without a legacy fallback',()=>{for(const capability of ['partner.create','partner.edit','partner.disable','partner.ownership.create','partner.ownership.edit','partner.ownership.confirm'])expect(app).toContain(`c.includes('${capability}')`);expect(app).not.toContain("c.includes('partner.manage')")});
});
