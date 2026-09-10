import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { VatAdjustmentConflictError, VatAdjustmentService } from '../src/modules/vat/vat-adjustments.router';

const COMPANY='11111111-1111-4111-8111-111111111111';
const ACTOR='22222222-2222-4222-8222-222222222222';
const ADJUSTMENT='33333333-3333-4333-8333-333333333333';

function poolWith(query:(sql:string,params:unknown[])=>Promise<{rows:unknown[];rowCount?:number}>){
  const client={query:vi.fn((sql:string,params:unknown[]=[])=>query(sql,params)),release:vi.fn()};
  return {pool:{connect:vi.fn(async()=>client)} as unknown as Pool,client};
}

describe('Phase 6B3 VAT adjustment recovery behavior',()=>{
  it('guards the open adjustment recognition period instead of the closed historical tax date',async()=>{
    const guarded:string[]=[];
    const {pool}=poolWith(async(sql,params)=>{
      if(sql==='BEGIN'||sql==='COMMIT')return{rows:[]};
      if(sql.includes('FROM document_vat_reviews r JOIN documents'))return{rows:[{tax_date:'2025-01-15',review_status:'reviewed',document_type:'sale',vat_amount:'15.00',recoverable_vat_amount:null}]};
      if(sql.includes('SELECT o.status original_status'))return{rows:[{original_status:'closed',adjustment_status:'open',period_start:'2026-04-01'}]};
      if(sql.includes('FROM monthly_close_periods')){guarded.push(String(params[1]));return{rows:[],rowCount:0};}
      if(sql.includes('INSERT INTO vat_adjustments'))return{rows:[{id:ADJUSTMENT,status:'draft',version:1}]};
      return{rows:[]};
    });
    await new VatAdjustmentService(pool).create(COMPANY,ACTOR,{documentId:ADJUSTMENT,originalId:ADJUSTMENT,adjustmentId:ADJUSTMENT,type:'amount_correction',reason:'Correction',taxable:'1.00',vat:'1.00',recoverable:'0',version:undefined});
    expect(guarded).toEqual(['2026-04-01']);
  });

  it('rejects business-field edits after draft review',async()=>{
    const {pool}=poolWith(async sql=>{
      if(sql==='BEGIN'||sql==='ROLLBACK')return{rows:[]};
      if(sql.startsWith('SELECT * FROM vat_adjustments'))return{rows:[{id:ADJUSTMENT,status:'reviewed',version:2}]};
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(new VatAdjustmentService(pool).update(COMPANY,ACTOR,ADJUSTMENT,{type:'other',reason:'Changed',taxable:'1.00',vat:'0',recoverable:'0',version:2})).rejects.toThrow('Only draft adjustments can be edited');
  });

  it('bounds recoverability against cumulative applied gross and recoverable deltas',async()=>{
    const {pool,client}=poolWith(async(sql)=>{
      if(sql==='BEGIN'||sql==='COMMIT')return{rows:[]};
      if(sql.startsWith('SELECT * FROM vat_adjustments'))return{rows:[{id:ADJUSTMENT,company_id:COMPANY,document_vat_review_id:ADJUSTMENT,adjustment_vat_period_id:ADJUSTMENT,status:'reviewed',version:2,vat_amount_delta:'-2.00',recoverable_vat_amount_delta:'-2.00'}]};
      if(sql.startsWith('SELECT status,period_start'))return{rows:[{status:'open',period_start:'2026-04-01'}]};
      if(sql.includes('FROM monthly_close_periods'))return{rows:[],rowCount:0};
      if(sql.includes('SELECT d.document_type,r.vat_amount'))return{rows:[{document_type:'purchase',vat_amount:'10.00',recoverable_vat_amount:'8.00'}]};
      if(sql.includes('COALESCE(SUM(vat_amount_delta)'))return{rows:[{vat:'-3.00',recoverable:'-2.00'}]};
      if(sql.startsWith('UPDATE vat_adjustments SET status='))return{rows:[{id:ADJUSTMENT,status:'applied',version:3}]};
      return{rows:[]};
    });
    await expect(new VatAdjustmentService(pool).transition(COMPANY,ACTOR,ADJUSTMENT,'applied',2)).resolves.toMatchObject({status:'applied'});
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('SUM(vat_amount_delta)'),[COMPANY,ADJUSTMENT,ADJUSTMENT]);
  });

  it('rejects cumulative recoverability above cumulative gross VAT',async()=>{
    const {pool}=poolWith(async(sql)=>{
      if(sql==='BEGIN'||sql==='ROLLBACK')return{rows:[]};
      if(sql.startsWith('SELECT * FROM vat_adjustments'))return{rows:[{id:ADJUSTMENT,document_vat_review_id:ADJUSTMENT,adjustment_vat_period_id:ADJUSTMENT,status:'reviewed',version:2,vat_amount_delta:'-4.00',recoverable_vat_amount_delta:'0.00'}]};
      if(sql.startsWith('SELECT status,period_start'))return{rows:[{status:'open',period_start:'2026-04-01'}]};
      if(sql.includes('FROM monthly_close_periods'))return{rows:[],rowCount:0};
      if(sql.includes('SELECT d.document_type,r.vat_amount'))return{rows:[{document_type:'expense',vat_amount:'10.00',recoverable_vat_amount:'8.00'}]};
      if(sql.includes('COALESCE(SUM(vat_amount_delta)'))return{rows:[{vat:'-1.00',recoverable:'0.00'}]};
      return{rows:[]};
    });
    await expect(new VatAdjustmentService(pool).transition(COMPANY,ACTOR,ADJUSTMENT,'applied',2)).rejects.toBeInstanceOf(VatAdjustmentConflictError);
  });
});
