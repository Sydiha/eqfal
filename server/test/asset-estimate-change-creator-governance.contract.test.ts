import express,{NextFunction,Request,Response}from'express';
import request from'supertest';
import{beforeEach,describe,expect,it,vi}from'vitest';
import type{Pool}from'pg';

const COMPANY='11111111-1111-4111-8111-111111111111';
const ASSET='33333333-3333-4333-8333-333333333333';
const ESTIMATE='44444444-4444-4444-8444-444444444444';
const CREATOR='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_USER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mocks=vi.hoisted(()=>({context:null as null|{user:{id:string};activeCompanyId:string;capabilities:string[]},pool:null as Pool|null,estimateChangeRecord:null as any}));
vi.mock('../src/db/pool',()=>({get default(){return mocks.pool}}));
vi.mock('../src/modules/auth/origin.middleware',()=>({requireSameOrigin:(_q:Request,_s:Response,n:NextFunction)=>n()}));
vi.mock('../src/modules/auth/auth.middleware',()=>({getAuthenticatedContext:()=>mocks.context,requireAuth:(_q:Request,s:Response,n:NextFunction)=>mocks.context?n():void s.status(401).end(),requireActiveCompany:(_q:Request,s:Response,n:NextFunction)=>mocks.context?.activeCompanyId?n():void s.status(403).end(),requireCapability:(cap:string)=>(_q:Request,s:Response,n:NextFunction)=>mocks.context?.capabilities.includes(cap)?n():void s.status(403).json({error:'Forbidden'})}));

const{assetEstimateChangeRouter}=await import('../src/modules/fixed-assets/asset-estimate-change.router');
const app=express();app.use(express.json());app.use('/api',assetEstimateChangeRouter);app.use((e:unknown,_q:Request,s:Response,_n:NextFunction)=>s.status(500).json({error:e instanceof Error?e.message:'error'}));

const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});

describe('asset estimate change creator-only edit governance - behavioral regression',()=>{
 beforeEach(()=>{
  mocks.estimateChangeRecord={
   id:ESTIMATE,company_id:COMPANY,asset_id:ASSET,status:'draft',created_by:CREATOR,
   effective_from:'2026-02-01',old_useful_life_months:60,new_remaining_useful_life_months:48,
   old_residual_value:'0.00',new_residual_value:null,reason:'Initial estimate',
   policy_exception:false,policy_exception_reason:null,reviewed_by:null,reviewed_at:null,
   approved_by:null,approved_at:null,created_at:new Date(),updated_at:new Date()
  };
  mocks.context={user:{id:CREATOR},activeCompanyId:COMPANY,capabilities:[]};
  const mockClient={
   query:vi.fn(async(sql:string,args:unknown[])=>{
    if(sql.includes('BEGIN')||sql.includes('COMMIT')||sql.includes('ROLLBACK')||sql.includes('pg_advisory'))return result();
    if(sql.includes('FROM asset_category_depreciation_policies'))return result();
    if(sql.includes('FROM fixed_assets')&&sql.includes('FOR UPDATE')){
     return result([{id:ASSET,company_id:COMPANY,status:'active',depreciation_policy_version_id:null,acquisition_cost:'1000.00',opening_accumulated_depreciation:'0.00',residual_value:'0.00',useful_life_months:60,depreciation_start_date:'2024-01-01'}]);
    }
    if(sql.includes('FROM asset_estimate_changes')&&sql.includes('FOR UPDATE')){
     return result([mocks.estimateChangeRecord]);
    }
    if(sql.includes('COUNT(*)::text count FROM asset_depreciation_entries')){
     return result([{count:'12'}]);
    }
    if(sql.includes('SELECT new_residual_value')){
     return result();
    }
    if(sql.includes('SUM(depreciation_amount)')){
     return result([{total:'0.00'}]);
    }
    if(sql.includes('UPDATE asset_estimate_changes')){
     mocks.estimateChangeRecord={...mocks.estimateChangeRecord,reason:args[7],updated_at:new Date()};
     return result([mocks.estimateChangeRecord]);
    }
    return result();
   }),
   release:vi.fn()
  };
  mocks.pool={
   query:mockClient.query,
   connect:vi.fn(async()=>mockClient)
  }as unknown as Pool;
 });

 it('creator can update draft estimate change, non-creator rejected with 409, record unchanged',async()=>{
  mocks.context!.capabilities=['asset.estimate_change.create'];
  const originalReason=mocks.estimateChangeRecord.reason;

  const creatorUpdate=await request(app).patch(`/api/asset-estimate-changes/${ESTIMATE}`).send({reason:'Updated by creator'});
  expect(creatorUpdate.status).toBe(200);
  expect(creatorUpdate.body.reason).toBe('Updated by creator');

  mocks.context!.user.id=OTHER_USER;
  const nonCreatorAttempt=await request(app).patch(`/api/asset-estimate-changes/${ESTIMATE}`).send({reason:'Attempted by non-creator'});
  expect(nonCreatorAttempt.status).toBe(409);
  expect(nonCreatorAttempt.body.error).toMatch(/Only the creator/i);

  expect(mocks.estimateChangeRecord.reason).toBe('Updated by creator');
  expect(mocks.estimateChangeRecord.reason).not.toBe('Attempted by non-creator');
 });
});
