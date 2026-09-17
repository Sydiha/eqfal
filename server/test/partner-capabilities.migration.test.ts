import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql=readFileSync(new URL('../migrations/046_partner_capability_granularity.sql',import.meta.url),'utf8');
const capabilities=['partner.create','partner.edit','partner.disable','partner.ownership.create','partner.ownership.edit','partner.ownership.confirm'];

describe('Migration 046 partner capability granularity',()=>{
 it('adds exactly the six approved write capabilities idempotently',()=>{for(const capability of capabilities)expect(sql.match(new RegExp(`\\('${capability.replaceAll('.','\\.')}'\\)`,'g'))).toHaveLength(2);expect(sql).toContain('ON CONFLICT (id) DO NOTHING');expect(sql).not.toContain("('partner.view')")});
 it('backfills every legacy manager role without removing the legacy grant',()=>{expect(sql).toContain("WHERE rc.capability_id = 'partner.manage'");expect(sql).toContain('ON CONFLICT (role_id, capability_id) DO NOTHING');expect(sql).not.toMatch(/DELETE|UPDATE\s+role_capabilities/i)});
});
