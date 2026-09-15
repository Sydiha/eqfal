import type { Pool, PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({audit:vi.fn()}));
vi.mock('../src/modules/audit-log/audit-log.repository',()=>({AuditLogRepository:class{logEvent=mocks.audit;}}));

import { TaxWorkpaperService, TaxWorkpaperValidationError } from '../src/modules/tax-working-papers/tax-working-paper.service';

const COMPANY='11111111-1111-4111-8111-111111111111';
const YEAR='22222222-2222-4222-8222-222222222222';
const USER='33333333-3333-4333-8333-333333333333';
const PROFILE='44444444-4444-4444-8444-444444444444';

const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});
const reviewed=()=>({id:'55555555-5555-4555-8555-555555555555',company_id:COMPANY,fiscal_year_id:YEAR,accounting_profile_id:null,tax_path:'needs_review',workflow_status:'reviewed',professional_review_required:false,version:3});

function poolFor(profile:{id:string;tax_treatment:string}|null){
  const queries:{sql:string;args:unknown[]}[]=[];
  const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
    queries.push({sql,args});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return result();
    if(sql.includes('FROM tax_working_papers'))return result([reviewed()]);
    if(sql.includes('FROM tax_working_paper_adjustments'))return result();
    if(sql.includes('FROM fiscal_years'))return result([{start_date:'2026-01-01',end_date:'2026-12-31'}]);
    if(sql.includes('FROM company_accounting_profiles'))return result(profile?[profile]:[]);
    if(sql.startsWith('UPDATE tax_working_papers'))return result([{...reviewed(),accounting_profile_id:args[6],tax_path:args[7],workflow_status:'approved',approved_by_user_id:USER,version:4}]);
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const client={query,release:vi.fn()} as unknown as PoolClient;
  return {pool:{connect:vi.fn().mockResolvedValue(client)} as unknown as Pool,queries};
}

describe('Tax workpaper approval applicability reconciliation',()=>{
  beforeEach(()=>mocks.audit.mockReset());

  it('links a reviewed needs-review workpaper to the profile that became applicable before approval',async()=>{
    const built=poolFor({id:PROFILE,tax_treatment:'zakat_applicable'});
    const approved=await new TaxWorkpaperService(built.pool).transition(COMPANY,YEAR,USER,'reviewed','approved',3);

    expect(approved).toMatchObject({workflow_status:'approved',accounting_profile_id:PROFILE,tax_path:'zakat',version:4});
    const applicability=built.queries.find(({sql})=>sql.includes('FROM company_accounting_profiles'))!;
    expect(applicability.args).toEqual([COMPANY,'2026-01-01','2026-12-31']);
    const update=built.queries.find(({sql})=>sql.startsWith('UPDATE tax_working_papers'))!;
    expect(update.sql).toContain('accounting_profile_id=$7,tax_path=$8');
    expect(update.sql).toContain('company_id=$2 AND workflow_status=$3 AND version=$5');
    expect(update.args).toEqual([reviewed().id,COMPANY,'reviewed','approved',3,USER,PROFILE,'zakat']);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({action:'tax_workpaper.approved',before_data:expect.objectContaining({accounting_profile_id:null,tax_path:'needs_review'}),after_data:expect.objectContaining({accounting_profile_id:PROFILE,tax_path:'zakat'})}),expect.anything());
  });

  it.each([
    ['no approved effective profile',null],
    ['applicability still needs review',{id:PROFILE,tax_treatment:'unsupported_treatment'}],
  ])('still blocks approval when there is %s',async(_caseName,profile)=>{
    const built=poolFor(profile);
    await expect(new TaxWorkpaperService(built.pool).transition(COMPANY,YEAR,USER,'reviewed','approved',3)).rejects.toBeInstanceOf(TaxWorkpaperValidationError);
    expect(built.queries.some(({sql})=>sql.startsWith('UPDATE tax_working_papers'))).toBe(false);
    expect(built.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
