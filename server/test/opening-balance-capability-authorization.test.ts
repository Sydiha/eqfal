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

import {openingBalancesRouter} from '../src/modules/opening-balances/opening-balances.router';

const app=express();
app.use(express.json());
app.use('/api',openingBalancesRouter);
app.use((_error:unknown,_req:Request,res:Response,_next:NextFunction)=>{res.status(500).json({error:'service unavailable'});});
const year='/api/opening-balances/11111111-1111-4111-8111-111111111111';
const item=`${year}/items/22222222-2222-4222-8222-222222222222`;
const actions=()=>({
 create:request(app).post(`${year}/items`).send({}),
 edit:request(app).patch(item).send({}),
 delete:request(app).delete(item),
 submit:request(app).post(`${year}/submit-review`).send({}),
 review:request(app).post(`${year}/return-to-draft`).send({reason:'correction'}),
 approve:request(app).post(`${year}/approve`).send({}),
});
const mapping={create:'opening_balance.item.create',edit:'opening_balance.item.edit',delete:'opening_balance.item.delete',submit:'opening_balance.submit',review:'opening_balance.review',approve:'opening_balance.approve'} as const;

describe('Opening Balance capability authorization behavior',()=>{
 beforeEach(()=>{mocks.capabilities.length=0;});
 for(const [allowed,capability] of Object.entries(mapping) as Array<[keyof typeof mapping,string]>)it(`${capability} authorizes only its mapped action`,async()=>{
  mocks.capabilities.push(capability);
  for(const [name,response] of Object.entries(actions())){
   const result=await response;
   if(name===allowed)expect(result.status,name).not.toBe(403);
   else expect(result.status,name).toBe(403);
  }
 });
 it('legacy manage does not authorize any corrected action',async()=>{
  mocks.capabilities.push('opening_balance.manage');
  for(const response of Object.values(actions()))expect((await response).status).toBe(403);
 });
});
