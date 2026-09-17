import express,{NextFunction,Request,Response} from 'express';
import request from 'supertest';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({capabilities:[] as string[]}));
vi.mock('../src/db/pool',()=>({default:null}));
vi.mock('../src/modules/auth/origin.middleware',()=>({requireSameOrigin:(_req:Request,_res:Response,next:NextFunction)=>next()}));
vi.mock('../src/modules/auth/auth.middleware',()=>({
 getAuthenticatedContext:vi.fn(()=>({user:{id:'user-1'},activeCompanyId:'co-a',capabilities:mocks.capabilities})),
 requireAuth:(_req:Request,_res:Response,next:NextFunction)=>next(),
 requireActiveCompany:(_req:Request,_res:Response,next:NextFunction)=>next(),
 requireCapability:(capability:string)=>(_req:Request,res:Response,next:NextFunction)=>mocks.capabilities.includes(capability)?next():void res.status(403).json({error:'Forbidden'}),
}));

import {periodicAdjustmentsRouter} from '../src/modules/periodic-adjustments/periodic-adjustments.router';

const app=express();
app.use(express.json());
app.use('/api',periodicAdjustmentsRouter);
app.use((_error:unknown,_req:Request,res:Response,_next:NextFunction)=>{res.status(500).json({error:'service unavailable'});});
const adjustment='/api/periodic-adjustments/22222222-2222-4222-8222-222222222222';
const actions=()=>({
 create:request(app).post('/api/periodic-adjustments').send({}),
 edit:request(app).patch(adjustment).send({}),
 submit:request(app).post(`${adjustment}/submit-review`).send({}),
 review:request(app).post(`${adjustment}/return-to-draft`).send({reason:'correction'}),
});
const expectOnly=async(capability:string,allowed:keyof ReturnType<typeof actions>)=>{
 mocks.capabilities.push(capability);
 for(const [name,response] of Object.entries(actions())){
  const result=await response;
  if(name===allowed)expect(result.status,name).not.toBe(403);
  else expect(result.status,name).toBe(403);
 }
};

describe('Phase 9A.7 Periodic Adjustments capability authorization behavior',()=>{
 beforeEach(()=>{mocks.capabilities.length=0;});
 it('create alone authorizes only create',()=>expectOnly('periodic_adjustment.create','create'));
 it('edit alone authorizes only draft editing',()=>expectOnly('periodic_adjustment.edit','edit'));
 it('submit alone authorizes only submit for review',()=>expectOnly('periodic_adjustment.submit','submit'));
 it('review alone authorizes only return to draft',()=>expectOnly('periodic_adjustment.review','review'));
 for(const capability of ['periodic_adjustment.approve','periodic_adjustment.post','periodic_adjustment.manage']){
  it(`${capability} does not authorize corrected actions`,async()=>{
   mocks.capabilities.push(capability);
   for(const response of Object.values(actions()))expect((await response).status).toBe(403);
  });
 }
});
