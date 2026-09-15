import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { AuditLogRepository } from '../src/modules/audit-log/audit-log.repository';
import { AnnualClosingService } from '../src/modules/annual-closing/annual-closing.service';
import { AnnualPackageConflictError, AnnualPackageNotFoundError, AnnualPackageService, AnnualPackageValidationError, finalizationBlockers, fingerprint, packageManifest } from '../src/modules/annual-closing/annual-package.service';
import { AnnualClosingResponse, ReadinessState } from '../src/modules/annual-closing/annual-closing.types';

const response=(overrides:Record<string,ReadinessState>={}):AnnualClosingResponse=>{
  const domain=(key:string)=>({ready:(overrides[key]??'ready')==='ready',status:overrides[key]??'ready',blocker_count:(overrides[key]??'ready')==='ready'?0:1,summary:{blockers:(overrides[key]??'ready')==='ready'?'':`${key}_blocker`}});
  const domains=Object.fromEntries(['monthly_close','ledger','vat','banking','receivables_payables','documents','partners','assets','adjustments','opening_balances','zakat'].map(key=>[key,domain(key)]));
  const financialKeys=['monthly_close','ledger','documents','assets','adjustments','opening_balances'];
  const financialBlockers=financialKeys.reduce((count,key)=>count+(domains[key]!.ready?0:domains[key]!.blocker_count),0);
  return {fiscal_year:{id:'fy',start_date:'2025-01-01',end_date:'2025-12-31',status:'open'},ready:financialBlockers===0,blocker_count:financialBlockers,domains,financial_statements_readiness:{status:financialBlockers?'needs_review':'ready',label:'',label_ar:''},zakat_readiness:{status:domains.zakat!.status as 'ready'},package_manifest:[{section:'financial_statements_readiness',status:financialBlockers?'blocked':'ready',blocker_count:financialBlockers,source:'annual-closing'}]};
};

describe('annual package governance',()=>{
  it('builds every mandatory source section with stable references and fingerprints',()=>{const manifest=packageManifest(response(),'2026-01-01T00:00:00.000Z');expect(manifest).toHaveLength(17);expect(manifest.map(x=>x.section)).toEqual(expect.arrayContaining(['statement_of_financial_position','profit_or_loss','changes_in_equity','cash_flow','tax_zakat_working_paper']));expect(manifest.every(x=>x.critical&&x.source&&x.fingerprint&&x.snapshot_as_of)).toBe(true);});
  it.each(['monthly_close','documents','assets','adjustments','opening_balances'])('uses authoritative financial-statement readiness for all statements when %s is blocked',domain=>{const manifest=packageManifest(response({[domain]:'blocked'}));for(const section of ['statement_of_financial_position','profit_or_loss','changes_in_equity','cash_flow'])expect(manifest.find(item=>item.section===section)).toMatchObject({status:'blocked',blocker_count:1});expect(finalizationBlockers(manifest)).toContain('cash_flow:blocked');});
  it.each(['blocked','needs_review','not_started','not_applicable'] as ReadinessState[])('fails closed for a critical %s section',status=>{expect(finalizationBlockers(packageManifest(response({zakat:status})))).toContain(`tax_zakat_working_paper:${status}`);});
  it('does not treat confirmed open receivable/payable balances as blockers',()=>{const value=response();value.domains.receivables_payables!.summary={unconfirmed_obligations:0,open_receivable_balance:'100.00',open_payable_balance:'50.00'};expect(finalizationBlockers(packageManifest(value))).toEqual([]);});
  it('fingerprints deterministically independent of object key insertion order',()=>{expect(fingerprint({a:1,b:{c:2}})).toBe(fingerprint({b:{c:2},a:1}));expect(fingerprint({a:2})).not.toBe(fingerprint({a:1}));});
});

type PackageRow={id:string;company_id:string;fiscal_year_id:string;status:'draft'|'finalized'|'handed_off';version:number;final_snapshot_id:string|null;[key:string]:unknown};
class PackageDb {
  package:PackageRow={id:'package-a',company_id:'company-a',fiscal_year_id:'fy',status:'draft',version:1,final_snapshot_id:null}; snapshots:any[]=[]; backup:null|{package:PackageRow;snapshots:any[]}=null;
  connect=vi.fn(async()=>({query:this.query,release:vi.fn()}));
  query=vi.fn(async(sql:string,args:unknown[]=[]):Promise<{rows:any[];rowCount:number}>=>{const normalized=sql.replace(/\s+/g,' ').trim();
    if(normalized==='BEGIN'){this.backup={package:{...this.package},snapshots:structuredClone(this.snapshots)};return{rows:[],rowCount:0};}
    if(normalized==='ROLLBACK'){if(this.backup){this.package=this.backup.package;this.snapshots=this.backup.snapshots;}this.backup=null;return{rows:[],rowCount:0};}
    if(normalized==='COMMIT'){this.backup=null;return{rows:[],rowCount:0};}
    if(normalized.startsWith('SELECT 1 FROM fiscal_years')){const found=args[0]==='fy'&&args[1]==='company-a';return{rows:found?[{one:1}]:[],rowCount:found?1:0};}
    if(normalized.startsWith('SELECT *,finalized_at::text')){const found=this.package.company_id===args[0]&&this.package.fiscal_year_id===args[1];return{rows:found?[{...this.package}]:[],rowCount:found?1:0};}
    if(normalized.startsWith('SELECT *,created_at::text')){const rows=this.snapshots.filter(item=>item.company_id===args[0]&&item.package_id===args[1]&&item.fiscal_year_id===args[2]).map(item=>structuredClone(item));return{rows,rowCount:rows.length};}
    if(normalized.startsWith('SELECT (COALESCE(MAX(snapshot_no)'))return{rows:[{n:String(this.snapshots.length+1)}],rowCount:1};
    if(normalized.startsWith('INSERT INTO annual_closing_package_snapshots')){const snapshot={id:`snapshot-${this.snapshots.length+1}`,company_id:args[0],package_id:args[1],fiscal_year_id:args[2],snapshot_no:args[3],snapshot_type:normalized.includes("'final'")?'final':'preview',manifest:JSON.parse(String(args[4])),readiness:JSON.parse(String(args[5])),source_fingerprint:args[6],created_by_user_id:args[7]};this.snapshots.push(snapshot);return{rows:[structuredClone(snapshot)],rowCount:1};}
    if(normalized.startsWith("UPDATE annual_closing_packages SET status='handed_off'")){if(this.package.id!==args[0]||this.package.company_id!==args[1]||this.package.status!=='finalized'||this.package.version!==args[5])return{rows:[],rowCount:0};Object.assign(this.package,{status:'handed_off',handed_off_by_user_id:args[2],handoff_note:args[3],handoff_reference:args[4],version:this.package.version+1});return{rows:[{...this.package}],rowCount:1};}
    if(normalized.startsWith('UPDATE annual_closing_packages')){if(this.package.id!==args[0]||this.package.company_id!==args[1]||this.package.status!=='draft'||this.package.version!==args[4])return{rows:[],rowCount:0};Object.assign(this.package,{status:'finalized',final_snapshot_id:args[2],finalized_by_user_id:args[3],version:this.package.version+1});return{rows:[{...this.package}],rowCount:1};}
    throw new Error(`Unhandled SQL: ${normalized}`);
  });
}

describe('annual package service behavior',()=>{
  let db:PackageDb;let readiness:AnnualClosingResponse;let audits:any[];
  beforeEach(()=>{db=new PackageDb();readiness=response();audits=[];vi.spyOn(AnnualClosingService.prototype,'readiness').mockImplementation(async(company,year)=>{if(company!=='company-a'||year!=='fy')throw new AnnualPackageNotFoundError();return structuredClone(readiness);});vi.spyOn(AuditLogRepository.prototype,'logEvent').mockImplementation(async event=>{audits.push(event);return event as never;});});
  it('rolls back a blocked finalization without a final snapshot or state transition',async()=>{readiness=response({documents:'blocked'});const service=new AnnualPackageService(db as unknown as Pool);await expect(service.finalize('company-a','fy','user-a',1)).rejects.toBeInstanceOf(AnnualPackageValidationError);expect(db.package).toMatchObject({status:'draft',version:1,final_snapshot_id:null});expect(db.snapshots).toEqual([]);expect(audits).toEqual([]);});
  it('rejects handoff before finalization',async()=>{const service=new AnnualPackageService(db as unknown as Pool);await expect(service.handoff('company-a','fy','user-a',{version:1,note:null,reference:null})).rejects.toBeInstanceOf(AnnualPackageConflictError);expect(db.package.status).toBe('draft');});
  it('keeps the final snapshot immutable while later source changes produce drift and lifecycle audits',async()=>{const service=new AnnualPackageService(db as unknown as Pool);await service.finalize('company-a','fy','user-a',1);await service.handoff('company-a','fy','user-a',{version:2,note:'Sent',reference:'REF-1'});const final=structuredClone(db.snapshots[0]);readiness=response({documents:'blocked'});const result=await service.get('company-a','fy');expect(result.drift).toBe(true);expect(db.snapshots[0]).toEqual(final);expect(audits.map(event=>event.action)).toEqual(['annual_package.snapshot_created','annual_package.finalized','annual_package.handed_off']);});
  it('tenant-scopes package and snapshot reads',async()=>{const service=new AnnualPackageService(db as unknown as Pool);await expect(service.get('company-b','fy')).rejects.toBeInstanceOf(AnnualPackageNotFoundError);expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id=$1 AND company_id=$2'),['fy','company-b']);});
});

describe('annual package persistence contract',()=>{
  const migration=readFileSync(new URL('../migrations/037_annual_closing_packages.sql',import.meta.url),'utf8');
  const service=readFileSync(new URL('../src/modules/annual-closing/annual-package.service.ts',import.meta.url),'utf8');
  const router=readFileSync(new URL('../src/modules/annual-closing/annual-closing.router.ts',import.meta.url),'utf8');
  it('uses tenant-bound keys, one package/final snapshot, and immutable snapshots',()=>{expect(migration).toContain('UNIQUE (company_id,fiscal_year_id)');expect(migration).toContain('annual_closing_package_one_final_idx');expect(migration).toContain('annual_closing_snapshot_immutable');expect(migration.match(/FOREIGN KEY \([^)]*company_id/g)?.length).toBeGreaterThanOrEqual(4);});
  it('independently protects all package operations',()=>{for(const cap of ['view','manage','finalize','handoff'])expect(router).toContain(`annual_close.package.${cap}`);expect(router).toContain('requireSameOrigin');});
  it('recomputes readiness inside finalization transaction and records lifecycle audits',()=>{expect(service).toContain('new AnnualClosingService(r).readiness');for(const event of ['annual_package.created','annual_package.snapshot_created','annual_package.finalized','annual_package.handed_off'])expect(service).toContain(event);expect(service).toContain("status!=='draft'");expect(service).toContain("status!=='finalized'");});
});
