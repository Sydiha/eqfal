import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { VatReturnConflictError, VatReturnNotFoundError, VatReturnService } from '../src/modules/vat/vat-returns.router';

const COMPANY='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const ACTOR='33333333-3333-4333-8333-333333333333';
const RETURN='44444444-4444-4444-8444-444444444444';
const PERIOD='55555555-5555-4555-8555-555555555555';
const base={id:RETURN,company_id:COMPANY,vat_period_id:PERIOD,status:'draft',snapshot_json:null,approved_by_user_id:null,approved_at:null,filed_by_user_id:null,filed_at:null,filing_reference:null,filing_note:null,version:1};

function mockPool(query:(sql:string,params:unknown[])=>Promise<{rows:any[]}>){
  const client={query:vi.fn((sql:string,params:unknown[]=[])=>query(sql,params)),release:vi.fn()};
  const pool={connect:vi.fn(async()=>client),query:vi.fn((sql:string,params:unknown[]=[])=>query(sql,params))} as unknown as Pool;
  return{pool,client};
}
const transaction=(handler:(sql:string,params:unknown[])=>Promise<{rows:any[]}>)=>mockPool(async(sql,params)=>['BEGIN','COMMIT','ROLLBACK'].includes(sql)?{rows:[]}:handler(sql,params));

describe('Phase 6B4 VAT returns',()=>{
  it('scopes every read to the active company',async()=>{
    const seen:unknown[][]=[];const{pool}=mockPool(async(_sql,params)=>{seen.push(params);return{rows:[]};});const service=new VatReturnService(pool);
    await service.list(COMPANY);await expect(service.get(OTHER,RETURN)).rejects.toBeInstanceOf(VatReturnNotFoundError);
    expect(seen).toEqual([[COMPANY],[RETURN,OTHER]]);
  });

  it('requires a closed tenant period and prevents duplicate returns',async()=>{
    const open=transaction(async sql=>sql.startsWith('SELECT status FROM vat_periods')?{rows:[{status:'open'}]}:{rows:[]});
    await expect(new VatReturnService(open.pool).create(COMPANY,ACTOR,PERIOD)).rejects.toThrow('VAT period must be closed');
    const duplicate=transaction(async sql=>{if(sql.startsWith('SELECT status FROM vat_periods'))return{rows:[{status:'closed'}]};if(sql.startsWith('INSERT INTO vat_returns'))throw Object.assign(new Error('unique'),{code:'23505'});return{rows:[]};});
    await expect(new VatReturnService(duplicate.pool).create(COMPANY,ACTOR,PERIOD)).rejects.toThrow('already exists');
  });

  it('creates a draft and its audit event atomically',async()=>{
    const actions:string[]=[];const{pool}=transaction(async(sql,params)=>{if(sql.startsWith('SELECT status FROM vat_periods'))return{rows:[{status:'closed'}]};if(sql.startsWith('INSERT INTO vat_returns'))return{rows:[base]};if(sql.includes('INSERT INTO audit_log')){actions.push(String(params[2]));return{rows:[{}]};}throw new Error(sql);});
    await expect(new VatReturnService(pool).create(COMPANY,ACTOR,PERIOD)).resolves.toMatchObject({status:'draft'});expect(actions).toEqual(['vat_return.create']);
  });

  it('approves only a current draft and captures the complete closing report snapshot',async()=>{
    let snapshot:any;const actions:string[]=[];const{pool}=transaction(async(sql,params)=>{
      if(sql.startsWith('SELECT * FROM vat_returns'))return{rows:[base]};
      if(sql.includes('FROM vat_periods vp JOIN companies'))return{rows:[{id:PERIOD,period_start:'2026-01-01',period_end:'2026-03-31',status:'closed',company_name:'EQFAL'}]};
      if(sql.includes('FROM documents d JOIN document_vat_reviews'))return{rows:[]};
      if(sql.includes('FROM vat_adjustments a JOIN'))return{rows:[{}]};
      if(sql.includes('FROM obligations o'))return{rows:[]};
      if(sql.startsWith("UPDATE vat_returns SET status='approved'")){snapshot=params[2];return{rows:[{...base,status:'approved',snapshot_json:snapshot,version:2}]};}
      if(sql.includes('INSERT INTO audit_log')){actions.push(String(params[2]));return{rows:[{}]};}
      throw new Error(sql);
    });
    const approved=await new VatReturnService(pool).approve(COMPANY,ACTOR,RETURN,1);
    expect(snapshot).toMatchObject({company:{id:COMPANY,name:'EQFAL'},period:{id:PERIOD},totals:{output_vat:0,gross_reviewed_input_vat:0,recoverable_input_vat:0,output_vat_adjustments:0,gross_input_vat_adjustments:0,recoverable_input_vat_adjustments:0,final_output_vat:0,final_recoverable_input_vat:0,base_net_vat:0,final_net_vat:0},adjustments:[],reconciliation:{},source:{kind:'vat_closing_report',vat_return_snapshot_version:1}});
    expect(snapshot.approved_at).toBe(snapshot.generated_at);expect(approved.status).toBe('approved');expect(actions).toEqual(['vat_return.approve']);
  });

  it('rejects invalid direct transitions and optimistic version conflicts',async()=>{
    const invalid=transaction(async sql=>sql.startsWith('SELECT * FROM vat_returns')?{rows:[{...base,status:'filed',version:3}]}:{rows:[]});
    await expect(new VatReturnService(invalid.pool).approve(COMPANY,ACTOR,RETURN,3)).rejects.toThrow('Invalid VAT return transition');
    const stale=transaction(async sql=>sql.startsWith('SELECT * FROM vat_returns')?{rows:[{...base,status:'approved',version:2,snapshot_json:{official:true}}]}:{rows:[]});
    await expect(new VatReturnService(stale.pool).file(COMPANY,ACTOR,RETURN,{version:1,reference:'F-1',note:null})).rejects.toThrow('modified');
  });

  it('files from the approved snapshot without recalculating and records filing audit',async()=>{
    const snapshot={final_net_vat:125,documents:[{id:'historical'}]};const actions:string[]=[];const{pool,client}=transaction(async(sql,params)=>{
      if(sql.startsWith('SELECT * FROM vat_returns'))return{rows:[{...base,status:'approved',version:2,snapshot_json:snapshot}]};
      if(sql.startsWith("UPDATE vat_returns SET status='filed'"))return{rows:[{...base,status:'filed',version:3,snapshot_json:snapshot,filing_reference:params[3],filing_note:params[4]}]};
      if(sql.includes('INSERT INTO audit_log')){actions.push(String(params[2]));return{rows:[{}]};}throw new Error(sql);
    });
    const filed=await new VatReturnService(pool).file(COMPANY,ACTOR,RETURN,{version:2,reference:'ZATCA-123',note:'Filed manually'});
    expect(filed.snapshot_json).toBe(snapshot);expect(filed).toMatchObject({status:'filed',filing_reference:'ZATCA-123'});expect(actions).toEqual(['vat_return.file']);
    expect(client.query.mock.calls.some(([sql])=>String(sql).includes('document_vat_reviews')||String(sql).includes('vat_adjustments'))).toBe(false);
  });
});

describe('VAT return database invariants',()=>{
  const sql=readFileSync(new URL('../migrations/031_vat_returns.sql',import.meta.url),'utf8');
  it('enforces tenant-safe uniqueness and lifecycle fields',()=>{expect(sql).toContain('UNIQUE (company_id, vat_period_id)');expect(sql).toContain('FOREIGN KEY (vat_period_id, company_id)');expect(sql).toContain("status IN ('draft','approved','filed')");});
  it('makes the approved snapshot and entire filed record immutable',()=>{expect(sql).toContain("OLD.status IN ('approved','filed')");expect(sql).toContain("OLD.status = 'filed'");expect(sql).toContain('vat_return_immutability_guard');});
});
