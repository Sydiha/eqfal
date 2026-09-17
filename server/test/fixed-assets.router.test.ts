import express,{NextFunction,Request,Response}from'express';
import request from'supertest';
import{beforeEach,describe,expect,it,vi}from'vitest';
import type{Pool}from'pg';
const COMPANY='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',ASSET='33333333-3333-4333-8333-333333333333';
const mocks=vi.hoisted(()=>({context:null as null|{user:{id:string};activeCompanyId:string;capabilities:string[]},pool:null as Pool|null}));
vi.mock('../src/db/pool',()=>({get default(){return mocks.pool}}));
vi.mock('../src/modules/auth/origin.middleware',()=>({requireSameOrigin:(_q:Request,_s:Response,n:NextFunction)=>n()}));
vi.mock('../src/modules/auth/auth.middleware',()=>({getAuthenticatedContext:()=>mocks.context,requireAuth:(_q:Request,s:Response,n:NextFunction)=>mocks.context?n():void s.status(401).end(),requireActiveCompany:(_q:Request,s:Response,n:NextFunction)=>mocks.context?.activeCompanyId?n():void s.status(403).end(),requireCapability:(cap:string)=>(_q:Request,s:Response,n:NextFunction)=>mocks.context?.capabilities.includes(cap)?n():void s.status(403).json({error:'Forbidden'})}));
const{fixedAssetsRouter}=await import('../src/modules/fixed-assets/fixed-assets.router');
const app=express();app.use(express.json());app.use('/api',fixedAssetsRouter);app.use((e:unknown,_q:Request,s:Response,_n:NextFunction)=>s.status(500).json({error:e instanceof Error?e.message:'error'}));
const result=(rows:unknown[]=[])=>({rows,rowCount:rows.length});
beforeEach(()=>{mocks.context={user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},activeCompanyId:COMPANY,capabilities:[]};mocks.pool={query:vi.fn(async(sql:string,args:unknown[])=>{if(sql.includes('FROM fixed_assets a JOIN asset_categories'))return args[1]===COMPANY?result([{id:ASSET,company_id:COMPANY}]):result();if(sql.includes('FROM fixed_assets WHERE'))return result();if(sql.includes('FROM asset_categories'))return result();throw Error(sql)})}as unknown as Pool});
describe('fixed-assets HTTP authorization and tenancy',()=>{
 it('requires asset.view for register and category reads',async()=>{expect((await request(app).get('/api/assets')).status).toBe(403);expect((await request(app).get('/api/asset-categories')).status).toBe(403)});
 it.each([
  ['post','/api/assets/from-document','asset.create'],
  ['post','/api/assets/manual','asset.create'],
  ['patch',`/api/assets/${ASSET}`,'asset.edit'],
  ['post',`/api/assets/${ASSET}/cancel`,'asset.cancel'],
  ['patch',`/api/asset-categories/${ASSET}`,'asset.policy.manage'],
  ['post',`/api/assets/${ASSET}/approve`,'asset.approve'],
  ['post',`/api/assets/${ASSET}/dispose`,'asset.dispose'],
 ] as const)('requires %s %s to have %s',async(method,path)=>{expect((await request(app)[method](path).send({})).status).toBe(403)});
 it('does not let asset.create authorize other asset actions',async()=>{mocks.context!.capabilities=['asset.create'];for(const [method,path] of [['patch',`/api/assets/${ASSET}`],['post',`/api/assets/${ASSET}/cancel`],['patch',`/api/asset-categories/${ASSET}`],['post',`/api/assets/${ASSET}/approve`],['post',`/api/assets/${ASSET}/dispose`]] as const)expect((await request(app)[method](path).send({})).status).toBe(403)});
 it('uses active company in asset lookup and returns safe not-found cross-tenant',async()=>{mocks.context!.capabilities=['asset.view'];expect((await request(app).get(`/api/assets/${ASSET}`)).status).toBe(200);mocks.context!.activeCompanyId=OTHER;const response=await request(app).get(`/api/assets/${ASSET}`);expect(response.status).toBe(404);expect(response.body).toEqual({error:'Not found'})});
 it('returns generated depreciation rows in ascending period order with serialized dates',async()=>{mocks.context!.capabilities=['asset.view'];const entries=[{id:'44444444-4444-4444-8444-444444444444',asset_id:ASSET,company_id:COMPANY,period_start:'2026-01-01',period_end:'2026-01-31',depreciation_amount:'100.00'},{id:'55555555-5555-4555-8555-555555555555',asset_id:ASSET,company_id:COMPANY,period_start:'2026-02-01',period_end:'2026-02-28',depreciation_amount:'100.00'}];mocks.pool={query:vi.fn(async(sql:string,args:unknown[])=>{if(sql==='SELECT 1 FROM fixed_assets WHERE id=$1 AND company_id=$2'){expect(args).toEqual([ASSET,COMPANY]);return result([{one:1}])}if(sql.includes('FROM asset_depreciation_entries e')){expect(sql).toContain('e.period_start::text AS period_start,e.period_end::text AS period_end');expect(sql).toContain('ORDER BY e.period_start ASC');expect(args).toEqual([ASSET,COMPANY]);return result(entries)}throw Error(sql)})}as unknown as Pool;const response=await request(app).get(`/api/assets/${ASSET}/depreciation`);expect(response.status).toBe(200);expect(response.body.entries).toEqual(entries);expect(response.body.entries.map((entry:{period_start:string})=>entry.period_start)).toEqual(['2026-01-01','2026-02-01']);expect(response.body.entries.every((entry:{period_start:unknown;period_end:unknown})=>typeof entry.period_start==='string'&&typeof entry.period_end==='string')).toBe(true)});
 it('rejects manual creation without reason and reference before database mutation',async()=>{mocks.context!.capabilities=['asset.create'];expect((await request(app).post('/api/assets/manual').send({})).status).toBe(400)});
});
