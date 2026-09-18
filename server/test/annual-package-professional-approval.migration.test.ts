import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql=readFileSync(new URL('../migrations/055_annual_package_professional_approval.sql',import.meta.url),'utf8');
describe('annual package professional approval migration',()=>{
  it('adds bounded review and approval metadata and lifecycle states',()=>{for(const value of ['reviewed','approved','reviewed_by_user_id','approved_by_user_id','review_note','approval_note'])expect(sql).toContain(value);expect(sql.match(/char_length\([^)]*note\) <= 2000/g)).toHaveLength(2);});
  it('adds granular capabilities using existing package authority only',()=>{expect(sql).toContain("'annual_close.package.review'");expect(sql).toContain("'annual_close.package.approve'");expect(sql).toContain("WHERE rc.capability_id = 'annual_close.package.manage'");});
});
