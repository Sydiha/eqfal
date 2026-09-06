import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const router=readFileSync(new URL('../src/modules/company-accounting-profile/company-accounting-profile.router.ts',import.meta.url),'utf8');
const repository=readFileSync(new URL('../src/modules/company-accounting-profile/company-accounting-profile.repository.ts',import.meta.url),'utf8');
const service=readFileSync(new URL('../src/modules/company-accounting-profile/company-accounting-profile.service.ts',import.meta.url),'utf8');

describe('company accounting profile API contract',()=>{
  it('exposes only scoped reads and workflow writes with the four capabilities',()=>{for(const capability of ['view','manage','review','approve'])expect(router).toContain(`company_accounting_profile.${capability}`);for(const path of ['current','history',':id','versions',':id/submit-review',':id/review',':id/approve'])expect(router).toContain(`/company-accounting-profiles/${path}`);});
  it('places same-origin protection on every write route',()=>{expect(router).toContain("companyAccountingProfileRouter[method](path,requireSameOrigin,...base,requireCapability(cap)");});
  it('company-scopes every identifier read/write and uses a serialized version increment',()=>{expect(repository).toContain('WHERE p.id=$1 AND p.company_id=$2');expect(repository).toContain('WHERE id=$1 AND company_id=$2');expect(service).toContain("pg_advisory_xact_lock(hashtext($1))");expect(repository).toContain('COALESCE(MAX(version_no),0)+1');});
  it('derives current/effective and closed-period impact without mutating financial data',()=>{expect(repository).toContain("p.workflow_status='approved'");expect(repository).toContain('p.effective_from<=$2');expect(repository).toContain("FROM monthly_close_periods m");expect(service).not.toContain('assertAccountingDateWritable');for(const forbidden of ['UPDATE monthly_close_periods','UPDATE transactions','UPDATE documents','UPDATE vat_'])expect(service+repository).not.toContain(forbidden);});
  it('keeps audit in each service transaction and detects all professional-review flags',()=>{for(const action of ['create','update_draft','submit_review','review','approve','supersede'])expect(service).toContain(`company_accounting_profile.${action}`);for(const flag of ['Other / accountant-reviewed','needs_review','unknown_needs_review','unknown'])expect(repository).toContain(flag);});
});
