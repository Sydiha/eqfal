import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DOC='22222222-2222-4222-8222-222222222222';
const TX='11111111-1111-4111-8111-111111111111';
const SETTLEMENT='33333333-3333-4333-8333-333333333333';
const ACTOR='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mocks=vi.hoisted(()=>({
  context:null as null|{user:{id:string;email:string};allowedCompanies:{id:string;name:string;name_ar:string|null}[];activeCompanyId:string|null;capabilities:string[]},
  query:vi.fn(),connect:vi.fn(),auditLogEvent:vi.fn(),
}));

vi.mock('../src/db/pool',()=>({default:{query:mocks.query,connect:mocks.connect}}));
vi.mock('../src/modules/audit-log/audit-log.repository',()=>({AuditLogRepository:class{logEvent=mocks.auditLogEvent;}}));
vi.mock('../src/modules/auth/auth.middleware',()=>({
  getAuthenticatedContext:vi.fn(()=>mocks.context),
  requireAuth:(_req:Request,res:Response,next:NextFunction)=>mocks.context?next():void res.status(401).json({error:'Unauthenticated'}),
  requireActiveCompany:(_req:Request,res:Response,next:NextFunction)=>mocks.context?.activeCompanyId?next():void res.status(403).json({error:'No active company'}),
  requireCapability:(capability:string)=>(_req:Request,res:Response,next:NextFunction)=>mocks.context?.capabilities.includes(capability)?next():void res.status(403).json({error:'Forbidden'}),
}));

import { documentSettlementRouter } from '../src/modules/banking/document-settlement.router';

const app=express();app.use(express.json());app.use('/api',documentSettlementRouter);app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>res.status(500).json({error:err instanceof Error?err.message:'error'}));
function setContext(capabilities:string[],companyId:string|null='co-a'){mocks.context={user:{id:ACTOR,email:'u@example.com'},allowedCompanies:[{id:'co-a',name:'A',name_ar:null}],activeCompanyId:companyId,capabilities};}
function makeClient(handler:(sql:string,params?:unknown[])=>unknown|Promise<unknown>){return{query:vi.fn((sql:string,params?:unknown[])=>Promise.resolve(handler(sql,params))),release:vi.fn()};}
const approved={id:DOC,company_id:'co-a',status:'approved',total_amount:'100.00',original_filename:'invoice.pdf'};
const settlement={id:SETTLEMENT,company_id:'co-a',document_id:DOC,bank_transaction_id:TX,amount:'40.00',created_by_user_id:ACTOR,created_at:new Date(),note:null};

beforeEach(()=>{mocks.context=null;mocks.query.mockReset();mocks.connect.mockReset();mocks.auditLogEvent.mockReset();mocks.auditLogEvent.mockResolvedValue({});});

describe('Document settlement authorization',()=>{
  it('requires authentication, active company, and payment.settle for mutation',async()=>{
    expect((await request(app).get(`/api/documents/${DOC}/settlements`)).status).toBe(401);
    setContext(['bank.view'],null);expect((await request(app).get(`/api/documents/${DOC}/settlements`)).status).toBe(403);
    setContext(['bank.view']);expect((await request(app).post(`/api/documents/${DOC}/settlements`).send({bank_transaction_id:TX,amount:'10.00'})).status).toBe(403);
  });

  it('scopes document reads to active company and ignores forged company_id',async()=>{
    setContext(['bank.view']);mocks.query.mockResolvedValueOnce({rows:[]});
    const res=await request(app).get(`/api/documents/${DOC}/settlements?company_id=co-b`);
    expect(res.status).toBe(404);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('id=$1 AND company_id=$2'),[DOC,'co-a']);
  });
});

describe('Document settlement rules',()=>{
  it('creates a partial settlement only for the existing same-company match and audits atomically',async()=>{
    setContext(['payment.settle']);
    const client=makeClient((sql)=>{
      if(sql==='BEGIN'||sql==='COMMIT')return{rows:[]};
      if(sql.includes('FROM documents'))return{rows:[approved]};
      if(sql.includes('FROM bank_transactions'))return{rows:[{id:TX,company_id:'co-a'}]};
      if(sql.includes('FROM bank_transaction_matches'))return{rows:[{bank_transaction_id:TX,company_id:'co-a',document_id:DOC}]};
      if(sql.includes('SUM(amount)'))return{rows:[{total:'0'}]};
      if(sql.includes('INSERT INTO document_settlements'))return{rows:[settlement]};
      return{rows:[]};
    });
    mocks.connect.mockResolvedValue(client);
    const res=await request(app).post(`/api/documents/${DOC}/settlements`).send({bank_transaction_id:TX,amount:'40.00'});
    expect(res.status).toBe(201);expect(res.body.remaining_amount).toBe('60.00');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'),[DOC,'co-a']);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'),[TX,'co-a']);
    expect(mocks.auditLogEvent).toHaveBeenCalledWith(expect.objectContaining({action:'document_settlement.create',company_id:'co-a'}),client);
  });

  it('keeps cent-exact arithmetic beyond JavaScript safe integers',async()=>{
    setContext(['payment.settle']);
    const hugeApproved={...approved,total_amount:'9999999999999999.99'};
    const hugeSettlement={...settlement,amount:'0.01'};
    const client=makeClient((sql)=>{
      if(sql==='BEGIN'||sql==='COMMIT')return{rows:[]};
      if(sql.includes('FROM documents'))return{rows:[hugeApproved]};
      if(sql.includes('FROM bank_transactions'))return{rows:[{id:TX,company_id:'co-a'}]};
      if(sql.includes('FROM bank_transaction_matches'))return{rows:[{bank_transaction_id:TX,company_id:'co-a',document_id:DOC}]};
      if(sql.includes('SUM(amount)'))return{rows:[{total:'9999999999999999.98'}]};
      if(sql.includes('INSERT INTO document_settlements'))return{rows:[hugeSettlement]};
      return{rows:[]};
    });
    mocks.connect.mockResolvedValue(client);
    const res=await request(app).post(`/api/documents/${DOC}/settlements`).send({bank_transaction_id:TX,amount:'0.01'});
    expect(res.status).toBe(201);
    expect(res.body.settled_amount).toBe('9999999999999999.99');
    expect(res.body.remaining_amount).toBe('0.00');
    expect(mocks.auditLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      before_data:expect.objectContaining({settled_amount:'9999999999999999.98'}),
      after_data:expect.objectContaining({settled_amount:'9999999999999999.99'}),
    }),client);
  });

  it('rejects settlement when document is not approved',async()=>{
    setContext(['payment.settle']);
    const client=makeClient((sql)=>{if(sql==='BEGIN'||sql==='ROLLBACK')return{rows:[]};if(sql.includes('FROM documents'))return{rows:[{...approved,status:'needs_review'}]};return{rows:[]};});
    mocks.connect.mockResolvedValue(client);
    expect((await request(app).post(`/api/documents/${DOC}/settlements`).send({bank_transaction_id:TX,amount:'10.00'})).status).toBe(409);
  });

  it('rejects over-settlement against remaining document amount',async()=>{
    setContext(['payment.settle']);
    const client=makeClient((sql)=>{
      if(sql==='BEGIN'||sql==='ROLLBACK')return{rows:[]};
      if(sql.includes('FROM documents'))return{rows:[approved]};
      if(sql.includes('FROM bank_transactions'))return{rows:[{id:TX,company_id:'co-a'}]};
      if(sql.includes('FROM bank_transaction_matches'))return{rows:[{bank_transaction_id:TX,company_id:'co-a',document_id:DOC}]};
      if(sql.includes('SUM(amount)'))return{rows:[{total:'80'}]};
      return{rows:[]};
    });
    mocks.connect.mockResolvedValue(client);
    expect((await request(app).post(`/api/documents/${DOC}/settlements`).send({bank_transaction_id:TX,amount:'30.00'})).status).toBe(409);
  });

  it('requires a bounded deletion reason and audits deletion',async()=>{
    setContext(['payment.settle']);
    expect((await request(app).delete(`/api/documents/${DOC}/settlements/${SETTLEMENT}`).send({})).status).toBe(400);
    const client=makeClient((sql)=>{
      if(sql==='BEGIN'||sql==='COMMIT')return{rows:[]};
      if(sql.includes('FROM documents'))return{rows:[approved]};
      if(sql.includes('SELECT * FROM document_settlements'))return{rows:[settlement]};
      if(sql.includes('SUM(amount)'))return{rows:[{total:'40'}]};
      return{rows:[]};
    });
    mocks.connect.mockResolvedValue(client);
    const res=await request(app).delete(`/api/documents/${DOC}/settlements/${SETTLEMENT}`).send({reason:'Entered by mistake'});
    expect(res.status).toBe(200);expect(res.body.settled_amount).toBe('0.00');
    expect(mocks.auditLogEvent).toHaveBeenCalledWith(expect.objectContaining({action:'document_settlement.delete'}),client);
  });
});
