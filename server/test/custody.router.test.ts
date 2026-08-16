import express,{NextFunction,Request,Response} from 'express';
import request from 'supertest';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const CUSTODY='33333333-3333-4333-8333-333333333333';
const mocks=vi.hoisted(()=>({context:null as null|{user:{id:string;email:string};allowedCompanies:{id:string;name:string;name_ar:string|null}[];activeCompanyId:string|null;capabilities:string[]},query:vi.fn(),connect:vi.fn(),audit:vi.fn()}));
vi.mock('../src/db/pool',()=>({default:{query:mocks.query,connect:mocks.connect}}));
vi.mock('../src/modules/audit-log/audit-log.repository',()=>({AuditLogRepository:class{logEvent=mocks.audit;}}));
vi.mock('../src/modules/auth/origin.middleware',()=>({requireSameOrigin:(_req:Request,_res:Response,next:NextFunction)=>next()}));
vi.mock('../src/modules/auth/auth.middleware',()=>({getAuthenticatedContext:vi.fn(()=>mocks.context),requireAuth:(_req:Request,res:Response,next:NextFunction)=>mocks.context?next():void res.status(401).json({error:'Unauthenticated'}),requireActiveCompany:(_req:Request,res:Response,next:NextFunction)=>mocks.context?.activeCompanyId?next():void res.status(403).json({error:'No active company'}),requireCapability:(cap:string)=>(_req:Request,res:Response,next:NextFunction)=>mocks.context?.capabilities.includes(cap)?next():void res.status(403).json({error:'Forbidden'})}));
import {custodyRouter} from '../src/modules/banking/custody.router';
const app=express();app.use(express.json());app.use('/api',custodyRouter);app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>res.status(500).json({error:err instanceof Error?err.message:'error'}));
function ctx(caps:string[],company:string|null='co-a'){mocks.context={user:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',email:'u@example.com'},allowedCompanies:[{id:'co-a',name:'A',name_ar:null}],activeCompanyId:company,capabilities:caps};}
beforeEach(()=>{mocks.context=null;mocks.query.mockReset();mocks.connect.mockReset();mocks.audit.mockReset();});
describe('Custody authorization boundary',()=>{
 it('requires authentication',async()=>expect((await request(app).get('/api/custodies')).status).toBe(401));
 it('requires an active company',async()=>{ctx(['custody.view'],null);expect((await request(app).get('/api/custodies')).status).toBe(403);});
 it('requires custody.view for reads',async()=>{ctx([]);expect((await request(app).get('/api/custodies')).status).toBe(403);});
 it('requires custody.manage for creation',async()=>{ctx(['custody.view']);expect((await request(app).post('/api/custodies').send({bank_transaction_id:'11111111-1111-4111-8111-111111111111'})).status).toBe(403);});
 it('requires custody.close independently for close',async()=>{ctx(['custody.view','custody.manage']);expect((await request(app).post(`/api/custodies/${CUSTODY}/close`).send({})).status).toBe(403);});
 it('rejects malformed custody ids before database access',async()=>{ctx(['custody.view']);const r=await request(app).get('/api/custodies/not-an-id');expect(r.status).toBe(400);expect(mocks.query).not.toHaveBeenCalled();});
});
