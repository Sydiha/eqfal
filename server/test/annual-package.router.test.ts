import express,{NextFunction,Request,Response} from 'express';
import request from 'supertest';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const YEAR='11111111-1111-4111-8111-111111111111';
const mocks=vi.hoisted(()=>({capabilities:[] as string[],create:vi.fn(),snapshot:vi.fn(),finalize:vi.fn(),handoff:vi.fn()}));
vi.mock('../src/db/pool',()=>({default:{}}));
vi.mock('../src/modules/annual-closing/annual-package.service',()=>({
  AnnualPackageNotFoundError:class extends Error{},AnnualPackageConflictError:class extends Error{},AnnualPackageValidationError:class extends Error{},
  AnnualPackageService:class{create=mocks.create;snapshot=mocks.snapshot;finalize=mocks.finalize;handoff=mocks.handoff;get=vi.fn();},
}));
vi.mock('../src/modules/auth/origin.middleware',()=>({requireSameOrigin:(_q:Request,_s:Response,next:NextFunction)=>next()}));
vi.mock('../src/modules/auth/auth.middleware',()=>({
  getAuthenticatedContext:()=>({user:{id:'user-a'},activeCompanyId:'company-a',capabilities:mocks.capabilities}),
  requireAuth:(_q:Request,_s:Response,next:NextFunction)=>next(),requireActiveCompany:(_q:Request,_s:Response,next:NextFunction)=>next(),
  requireCapability:(capability:string)=>(_q:Request,res:Response,next:NextFunction)=>mocks.capabilities.includes(capability)?next():void res.status(403).json({error:'Forbidden'}),
}));
const {annualClosingRouter}=await import('../src/modules/annual-closing/annual-closing.router');
const app=express();app.use(express.json());app.use('/api',annualClosingRouter);app.use((error:unknown,_q:Request,res:Response,_n:NextFunction)=>res.status(500).json({error:error instanceof Error?error.message:'error'}));
const post=(path:string,body:Record<string,unknown>)=>request(app).post(`/api/annual-closing/${YEAR}/package${path}`).send(body);

describe('annual package router capabilities',()=>{
  beforeEach(()=>{mocks.capabilities=[];for(const mock of [mocks.create,mocks.snapshot,mocks.finalize,mocks.handoff])mock.mockReset().mockResolvedValue({});});
  it.each([
    ['create','',{},'annual_close.package.create','create'],
    ['snapshot create','/snapshots',{version:1},'annual_close.package.snapshot.create','snapshot'],
    ['finalize','/finalize',{version:1},'annual_close.package.finalize','finalize'],
    ['handoff','/handoff',{version:1},'annual_close.package.handoff','handoff'],
  ])('enforces the backend %s capability independently',async(_label,path,body,capability,method)=>{expect((await post(path,body)).status).toBe(403);expect(mocks[method as keyof typeof mocks]).not.toHaveBeenCalled();mocks.capabilities=[capability];expect((await post(path,body)).status).not.toBe(403);expect(mocks[method as keyof typeof mocks]).toHaveBeenCalled();});
});
