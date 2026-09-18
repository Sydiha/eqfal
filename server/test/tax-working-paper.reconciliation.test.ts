import type { Pool, PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({audit:vi.fn()}));
vi.mock('../src/modules/audit-log/audit-log.repository',()=>({AuditLogRepository:class{logEvent=mocks.audit;}}));
import { TaxWorkpaperConflictError, TaxWorkpaperService, TaxWorkpaperValidationError } from '../src/modules/tax-working-papers/tax-working-paper.service';

const COMPANY='11111111-1111-4111-8111-111111111111',YEAR='22222222-2222-4222-8222-222222222222',USER='33333333-3333-4333-8333-333333333333';
const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});
const revenue={account_id:'a',code:'4000',account_type:'revenue',statement_category:'revenue',is_contra:false,debit:'0.00',credit:'1000.00'};
const expense={account_id:'b',code:'5000',account_type:'expense',statement_category:'operating_expense',is_contra:false,debit:'250.00',credit:'0.00'};

function fixture(){
 let source=[revenue,expense],persistedFingerprint:string|null=null,persistedBase:string|null=null,version=2,status='draft',reviewedBy:string|null=null,reviewedAt:string|null=null;
 const queries:{sql:string;args:unknown[]}[]=[];
 const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
  queries.push({sql,args});
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return result();
  if(sql.includes('FROM tax_working_papers'))return result([{id:'w',company_id:COMPANY,fiscal_year_id:YEAR,workflow_status:status,professional_review_required:false,accounting_profile_id:'p',tax_path:'zakat',starting_financial_base:persistedBase,source_fingerprint:persistedFingerprint,reviewed_by_user_id:reviewedBy,reviewed_at:reviewedAt,version}]);
  if(sql.includes('FROM tax_working_paper_adjustments'))return result([{id:'add',direction:'add',amount:'25.50',professional_review_required:false},{id:'deduct',direction:'deduct',amount:'10.25',professional_review_required:false}]);
  if(sql.includes('FROM fiscal_years'))return result([{start_date:'2026-01-01',end_date:'2026-12-31'}]);
  if(sql.includes('FROM journal_lines'))return result(source);
  if(sql.startsWith('UPDATE tax_working_papers SET starting_financial_base')){persistedBase=String(args[2]);persistedFingerprint=String(args[3]);if(status==='reviewed'){status='needs_review';reviewedBy=null;reviewedAt=null;}version++;return result([{}]);}
  if(sql.includes('FROM company_accounting_profiles'))return result([{id:'p',tax_treatment:'zakat_applicable'}]);
  if(sql.startsWith('UPDATE tax_working_papers SET workflow_status'))return result([{id:'w',workflow_status:'approved'}]);
  throw new Error(`Unexpected SQL: ${sql}`);
 });
 const client={query,release:vi.fn()} as unknown as PoolClient;
 return{service:new TaxWorkpaperService({connect:vi.fn().mockResolvedValue(client),query} as unknown as Pool),queries,setSource:(rows:typeof source)=>{source=rows;},setStatus:(value:string)=>{status=value;if(value==='reviewed'){reviewedBy=USER;reviewedAt='2026-09-18T00:00:00.000Z';}}};
}

describe('Tax workpaper financial-source reconciliation',()=>{
 beforeEach(()=>mocks.audit.mockReset());
 it('calculates the authoritative base and adjustment totals, then detects source drift deterministically',async()=>{
  const x=fixture();const legacy=await x.service.get(COMPANY,YEAR);expect(legacy).toMatchObject({starting_financial_base:null,additions_total:'25.50',deductions_total:'10.25',reconciled_base:null,source_drift:true});
  const reconciled=await x.service.reconcile(COMPANY,YEAR,USER,2);expect(reconciled).toMatchObject({starting_financial_base:'750.00',reconciled_base:'765.25',source_drift:false,workflow_status:'draft',version:3});
  const unchanged=await x.service.get(COMPANY,YEAR);expect(unchanged?.source_fingerprint).toBe(reconciled.source_fingerprint);expect(unchanged?.source_drift).toBe(false);
  x.setSource([revenue,{...expense,debit:'300.00'}]);expect((await x.service.get(COMPANY,YEAR))?.source_drift).toBe(true);
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({action:'tax_workpaper.reconcile'}),expect.anything());
 });
 it('preserves needs-review status when refreshing financial evidence',async()=>{
  const x=fixture();x.setStatus('needs_review');
  const reconciled=await x.service.reconcile(COMPANY,YEAR,USER,2);
  expect(reconciled).toMatchObject({workflow_status:'needs_review',reviewed_by_user_id:null,reviewed_at:null,version:3});
 });
 it('refreshes changed evidence with tenant/version/status guards and requires reviewed workpapers to be reviewed again',async()=>{
  const x=fixture();await x.service.reconcile(COMPANY,YEAR,USER,2);x.setSource([{...revenue,credit:'1200.00'},expense]);
  x.setStatus('reviewed');await expect(x.service.transition(COMPANY,YEAR,USER,'reviewed','approved',3)).rejects.toThrow(TaxWorkpaperValidationError);
  await expect(x.service.reconcile(COMPANY,YEAR,USER,2)).rejects.toThrow(TaxWorkpaperConflictError);
  const refreshed=await x.service.reconcile(COMPANY,YEAR,USER,3);expect(refreshed).toMatchObject({starting_financial_base:'950.00',source_drift:false,workflow_status:'needs_review',reviewed_by_user_id:null,reviewed_at:null,version:4});
  await expect(x.service.transition(COMPANY,YEAR,USER,'reviewed','approved',4)).rejects.toThrow(TaxWorkpaperConflictError);
  const update=x.queries.find(({sql,args})=>sql.startsWith('UPDATE tax_working_papers SET starting_financial_base')&&args[4]===3);expect(update?.sql).toContain('id=$1 AND company_id=$2 AND version=$5');expect(update?.args[1]).toBe(COMPANY);
  expect(update?.sql).toContain('workflow_status=$6');expect(update?.args[5]).toBe('reviewed');
 });
});
