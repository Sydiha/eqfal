import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { finalizationBlockers, fingerprint, packageManifest } from '../src/modules/annual-closing/annual-package.service';
import { AnnualClosingResponse, ReadinessState } from '../src/modules/annual-closing/annual-closing.types';

const response=(overrides:Record<string,ReadinessState>={}):AnnualClosingResponse=>{
  const domain=(key:string)=>({ready:(overrides[key]??'ready')==='ready',status:overrides[key]??'ready',blocker_count:(overrides[key]??'ready')==='ready'?0:1,summary:{blockers:(overrides[key]??'ready')==='ready'?'':`${key}_blocker`}});
  const domains=Object.fromEntries(['monthly_close','ledger','vat','banking','receivables_payables','documents','partners','assets','adjustments','opening_balances','zakat'].map(key=>[key,domain(key)]));
  return {fiscal_year:{id:'fy',start_date:'2025-01-01',end_date:'2025-12-31',status:'open'},ready:true,blocker_count:0,domains,financial_statements_readiness:{status:'ready',label:'',label_ar:''},zakat_readiness:{status:domains.zakat!.status as 'ready'},package_manifest:[]};
};

describe('annual package governance',()=>{
  it('builds every mandatory source section with stable references and fingerprints',()=>{const manifest=packageManifest(response(),'2026-01-01T00:00:00.000Z');expect(manifest).toHaveLength(17);expect(manifest.map(x=>x.section)).toEqual(expect.arrayContaining(['statement_of_financial_position','profit_or_loss','changes_in_equity','cash_flow','tax_zakat_working_paper']));expect(manifest.every(x=>x.critical&&x.source&&x.fingerprint&&x.snapshot_as_of)).toBe(true);});
  it.each(['blocked','needs_review','not_started','not_applicable'] as ReadinessState[])('fails closed for a critical %s section',status=>{expect(finalizationBlockers(packageManifest(response({zakat:status})))).toContain(`tax_zakat_working_paper:${status}`);});
  it('does not treat confirmed open receivable/payable balances as blockers',()=>{const value=response();value.domains.receivables_payables!.summary={unconfirmed_obligations:0,open_receivable_balance:'100.00',open_payable_balance:'50.00'};expect(finalizationBlockers(packageManifest(value))).toEqual([]);});
  it('fingerprints deterministically independent of object key insertion order',()=>{expect(fingerprint({a:1,b:{c:2}})).toBe(fingerprint({b:{c:2},a:1}));expect(fingerprint({a:2})).not.toBe(fingerprint({a:1}));});
});

describe('annual package persistence contract',()=>{
  const migration=readFileSync(new URL('../migrations/037_annual_closing_packages.sql',import.meta.url),'utf8');
  const service=readFileSync(new URL('../src/modules/annual-closing/annual-package.service.ts',import.meta.url),'utf8');
  const router=readFileSync(new URL('../src/modules/annual-closing/annual-closing.router.ts',import.meta.url),'utf8');
  it('uses tenant-bound keys, one package/final snapshot, and immutable snapshots',()=>{expect(migration).toContain('UNIQUE (company_id,fiscal_year_id)');expect(migration).toContain('annual_closing_package_one_final_idx');expect(migration).toContain('annual_closing_snapshot_immutable');expect(migration.match(/FOREIGN KEY \([^)]*company_id/g)?.length).toBeGreaterThanOrEqual(4);});
  it('independently protects all package operations',()=>{for(const cap of ['view','manage','finalize','handoff'])expect(router).toContain(`annual_close.package.${cap}`);expect(router).toContain('requireSameOrigin');});
  it('recomputes readiness inside finalization transaction and records lifecycle audits',()=>{expect(service).toContain('new AnnualClosingService(r).readiness');for(const event of ['annual_package.created','annual_package.snapshot_created','annual_package.finalized','annual_package.handed_off'])expect(service).toContain(event);expect(service).toContain("status!=='draft'");expect(service).toContain("status!=='finalized'");});
});
