import express,{NextFunction,Request,Response}from'express';
import request from'supertest';
import{beforeEach,describe,expect,it,vi}from'vitest';
import type{Pool,PoolClient}from'pg';

const COMPANY='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',FY='33333333-3333-4333-8333-333333333333',PERIOD='44444444-4444-4444-8444-444444444444',DOC='55555555-5555-4555-8555-555555555555',REVIEW='66666666-6666-4666-8666-666666666666';
const mocks=vi.hoisted(()=>({context:null as null|{user:{id:string};activeCompanyId:string;capabilities:string[]},pool:null as Pool|null,audit:vi.fn()}));
vi.mock('../src/db/pool',()=>({get default(){return mocks.pool}}));
vi.mock('../src/modules/audit-log/audit-log.repository',()=>({AuditLogRepository:class{logEvent=(event:unknown,client:unknown)=>mocks.audit(event,client)}}));
vi.mock('../src/modules/auth/origin.middleware',()=>({requireSameOrigin:(_q:Request,_s:Response,next:NextFunction)=>next()}));
vi.mock('../src/modules/auth/auth.middleware',()=>({getAuthenticatedContext:()=>mocks.context,requireAuth:(_q:Request,s:Response,n:NextFunction)=>mocks.context?n():void s.status(401).end(),requireActiveCompany:(_q:Request,s:Response,n:NextFunction)=>mocks.context?.activeCompanyId?n():void s.status(403).end(),requireCapability:(capability:string)=>(_q:Request,s:Response,n:NextFunction)=>mocks.context?.capabilities.includes(capability)?n():void s.status(403).json({error:'Forbidden'})}));
const vat=await import('../src/modules/vat/vat.router');
type Result={rows:Record<string,unknown>[];rowCount:number};const result=(rows:Record<string,unknown>[]=[]):Result=>({rows,rowCount:rows.length});
function poolFor(handler:(sql:string,args:unknown[])=>Result|Promise<Result>){const query=vi.fn((sql:string,args:unknown[]=[])=>/^SELECT (r\.id review_id|a\.id, a\.adjustment_type)/.test(sql)?result():handler(sql.replace(/\s+/g,' '),args));const client={query,release:vi.fn()}as unknown as PoolClient;return{pool:{connect:vi.fn().mockResolvedValue(client),query}as unknown as Pool,client,query};}
const period=(status:'open'|'closed'='open')=>({id:PERIOD,company_id:COMPANY,fiscal_year_id:FY,period_start:'2026-01-01',period_end:'2026-03-31',status,created_at:new Date(),updated_at:new Date()});
const profile=(overrides:Record<string,unknown>={})=>({id:'77777777-7777-4777-8777-777777777777',company_id:COMPANY,version_no:1,workflow_status:'approved',vat_status:'registered',vat_registered_from:'2025-01-01',vat_deregistered_from:null,vat_filing_frequency:'quarterly',...overrides});
const blockers=(u=0,m=0,p=0)=>({unapproved_documents:String(u),missing_reviews:String(m),pending_reviews:String(p),vat_recoverability_pending:'0'});
const review=(version=1)=>({id:REVIEW,company_id:COMPANY,document_id:DOC,tax_date:'2026-02-10',treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00',review_status:'reviewed',reviewed_by_user_id:USER,reviewed_at:new Date(),review_note:null,created_at:new Date(),updated_at:new Date(),version});
beforeEach(()=>{mocks.context=null;mocks.pool=null;mocks.audit.mockReset().mockResolvedValue({})});

/** P1: stable VAT error codes. HTTP statuses and legacy messages are unchanged; malformed and not-found responses stay code-free. */
const app=express();app.use(express.json());app.use('/api',vat.vatRouter);app.use((error:unknown,_q:Request,res:Response,_n:NextFunction)=>res.status(500).json({error:error instanceof Error?error.message:'error'}));
const as=(...capabilities:string[])=>{mocks.context={user:{id:USER},activeCompanyId:COMPANY,capabilities}};
const tx=(sql:string)=>['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('pg_advisory_xact_lock');
function createPool(opts:{fy?:{start_date:string;end_date:string}|null;profile?:Record<string,unknown>|null;overlap?:boolean}={}){return poolFor((sql)=>{if(tx(sql))return result();if(sql.includes('FROM fiscal_years'))return result(opts.fy===null?[]:[opts.fy??{start_date:'2026-01-01',end_date:'2026-12-31'}]);if(sql.includes('FROM company_accounting_profiles'))return result(opts.profile===null?[]:[profile(opts.profile??{})]);if(sql.includes('SELECT 1 FROM vat_periods WHERE company_id='))return result(opts.overlap?[{x:1}]:[]);if(sql.startsWith('INSERT INTO vat_periods'))return result([period()]);throw new Error(sql)}).pool;}
const create=(start='2026-01-01',end='2026-03-31')=>request(app).post('/api/vat-periods').send({fiscal_year_id:FY,period_start:start,period_end:end});

describe('VAT period creation error codes',()=>{
 const cases:Array<[string,Parameters<typeof createPool>[0],[string,string]|[],number,string,string]>=[
  ['outside its fiscal year',{fy:{start_date:'2026-02-01',end_date:'2026-12-31'}},[],400,'Period must be within its fiscal year','VAT_PERIOD_OUTSIDE_FISCAL_YEAR'],
  ['without one governing profile',{profile:null},[],409,'No single approved accounting profile governs this VAT period','VAT_PROFILE_NOT_SINGLE'],
  ['for a company that is not registered',{profile:{vat_status:'not_registered'}},[],409,'VAT registration status does not permit period creation','VAT_REGISTRATION_NOT_PERMITTED'],
  ['for a profile that needs review',{profile:{vat_status:'needs_review'}},[],409,'VAT registration status does not permit period creation','VAT_REGISTRATION_NOT_PERMITTED'],
  ['before VAT registration',{profile:{vat_registered_from:'2026-02-01'}},[],409,'VAT period starts before VAT registration','VAT_PERIOD_BEFORE_REGISTRATION'],
  ['beyond deregistration',{profile:{vat_status:'deregistered',vat_deregistered_from:'2026-03-01'}},[],409,'VAT period is outside the VAT registration window','VAT_PERIOD_OUTSIDE_REGISTRATION'],
  ['without a filing frequency',{profile:{vat_filing_frequency:null}},[],409,'VAT filing frequency is required','VAT_FILING_FREQUENCY_REQUIRED'],
  ['that is not one full month',{profile:{vat_filing_frequency:'monthly'}},['2026-01-01','2026-01-30'],409,'VAT period must be one complete calendar month','VAT_PERIOD_NOT_FULL_MONTH'],
  ['that is not one full quarter',{},['2026-01-01','2026-02-28'],409,'VAT period must be one complete calendar quarter','VAT_PERIOD_NOT_FULL_QUARTER'],
  ['that overlaps another period',{overlap:true},[],409,'VAT period overlaps an existing period','VAT_PERIOD_OVERLAP'],
 ];
 for(const [label,opts,dates,status,error,code] of cases)it(`rejects a period ${label} with ${status} ${code}`,async()=>{as('vat.close');mocks.pool=createPool(opts);const response=await create(...(dates as [string,string]));expect(response.status).toBe(status);expect(response.body).toEqual({error,code})});
 it('still creates a valid period',async()=>{as('vat.close');mocks.pool=createPool();expect((await create()).status).toBe(201)});
 it('keeps malformed requests and a missing or foreign fiscal year code-free',async()=>{as('vat.close');mocks.pool=createPool();const malformed=await request(app).post('/api/vat-periods').send({});expect(malformed.status).toBe(400);expect(malformed.body).toEqual({error:'Invalid request'});mocks.pool=createPool({fy:null});const missing=await create();expect(missing.status).toBe(404);expect(missing.body).toEqual({error:'Not found'})});
});

describe('VAT period close/reopen and review error codes',()=>{
 it('maps close of a non-open period and a period with blockers',async()=>{as('vat.close');mocks.pool=poolFor(sql=>{if(tx(sql))return result();if(sql.includes('FROM vat_periods WHERE id='))return result([period('closed')]);throw new Error(sql)}).pool;const notOpen=await request(app).post(`/api/vat-periods/${PERIOD}/close`).send({});expect(notOpen.status).toBe(409);expect(notOpen.body).toEqual({error:'VAT period is not open',code:'VAT_PERIOD_NOT_OPEN'});
  mocks.pool=poolFor(sql=>{if(tx(sql)||sql.startsWith('WITH scoped AS'))return result();if(sql.includes('FROM vat_periods WHERE id='))return result([period('open')]);if(sql.startsWith('SELECT (SELECT COUNT(*) FROM documents'))return result([blockers(0,1,0)]);throw new Error(sql)}).pool;const blocked=await request(app).post(`/api/vat-periods/${PERIOD}/close`).send({});expect(blocked.status).toBe(409);expect(blocked.body).toEqual({error:'VAT period has blockers',code:'VAT_PERIOD_HAS_BLOCKERS'})});
 it('maps reopen of a period that is not closed',async()=>{as('vat.reopen');mocks.pool=poolFor(sql=>{if(tx(sql))return result();if(sql.includes('FROM vat_periods WHERE id='))return result([period('open')]);throw new Error(sql)}).pool;const response=await request(app).post(`/api/vat-periods/${PERIOD}/reopen`).send({reason:'fix'});expect(response.status).toBe(409);expect(response.body).toEqual({error:'VAT period is not closed',code:'VAT_PERIOD_NOT_CLOSED'})});
 it('returns a foreign company period as a code-free 404',async()=>{as('vat.close');mocks.context!.activeCompanyId=OTHER;mocks.pool=poolFor(sql=>{if(tx(sql))return result();if(sql.includes('FROM vat_periods WHERE id='))return result();throw new Error(sql)}).pool;const response=await request(app).post(`/api/vat-periods/${PERIOD}/close`).send({});expect(response.status).toBe(404);expect(response.body).toEqual({error:'Not found'})});
 const reviewBody={tax_date:'2026-02-10',review_status:'reviewed',treatment:'standard',taxable_amount:'100.00',vat_amount:'15.00'};
 const reviewPool=(doc:Record<string,unknown>,extra:(sql:string)=>Result|null=()=>null)=>poolFor(sql=>{if(tx(sql))return result();const hit=extra(sql);if(hit)return hit;if(sql.startsWith('SELECT id,status,document_type FROM documents'))return result([doc]);throw new Error(sql)}).pool;
 it('maps an ineligible document review',async()=>{as('vat.review');mocks.pool=reviewPool({id:DOC,status:'pending_review',document_type:'purchase'});const response=await request(app).put(`/api/documents/${DOC}/vat-review`).send(reviewBody);expect(response.status).toBe(409);expect(response.body).toEqual({error:'Document is not eligible for VAT review',code:'VAT_DOCUMENT_NOT_ELIGIBLE'})});
 it('still requires vat.review for review writes',async()=>{as('vat.view');expect((await request(app).put(`/api/documents/${DOC}/vat-review`).send(reviewBody)).status).toBe(403)});
});

describe('VAT error code table',()=>{
 it('codes every user-facing VAT conflict and validation message except malformed requests',async()=>{const {readFileSync}=await import('node:fs');const source=readFileSync(new URL('../src/modules/vat/vat.router.ts',import.meta.url),'utf8');const messages=new Set([...source.matchAll(/new Vat(?:Conflict|Validation)Error\('([^']+)'\)/g)].map(m=>m[1]!));for(const m of ['Invalid request','Reason is required'])messages.delete(m);expect([...messages].filter(m=>!vat.VAT_ERROR_CODES[m])).toEqual([]);expect(new Set(Object.values(vat.VAT_ERROR_CODES)).size).toBe(Object.keys(vat.VAT_ERROR_CODES).length)});
});
