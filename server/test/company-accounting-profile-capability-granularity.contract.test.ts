import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration=readFileSync(new URL('../migrations/042_company_accounting_profile_capability_granularity.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/company-accounting-profile/company-accounting-profile.router.ts',import.meta.url),'utf8');

describe('Company Accounting Profile capability granularity contract',()=>{
  it('idempotently seeds and backfills the action-specific capabilities from manage holders only',()=>{
    for(const capability of ['create','edit','submit'])expect(migration).toContain(`'company_accounting_profile.${capability}'`);
    expect(migration).toContain("WHERE rc.capability_id = 'company_accounting_profile.manage'");
    expect(migration.match(/ON CONFLICT/g)).toHaveLength(2);
    expect(migration).not.toMatch(/DELETE|UPDATE/i);
  });

  it('maps every corrected route to its exact capability without a manage fallback',()=>{
    expect(router).toContain("write('post','/company-accounting-profiles','company_accounting_profile.create'");
    expect(router).toContain("write('post','/company-accounting-profiles/versions','company_accounting_profile.create'");
    expect(router).toContain("write('patch','/company-accounting-profiles/:id','company_accounting_profile.edit'");
    expect(router).toContain("write('post','/company-accounting-profiles/:id/submit-review','company_accounting_profile.submit'");
    expect(router).not.toContain("'company_accounting_profile.manage'");
  });
});
