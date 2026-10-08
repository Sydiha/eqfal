import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({
  context:null as null|{user:{id:string;email:string};allowedCompanies:{id:string;name:string;name_ar:string|null}[];activeCompanyId:string|null;capabilities:string[]},
  query:vi.fn(),storageGet:vi.fn(),
}));

vi.mock('../src/db/pool',()=>({default:{query:mocks.query}}));
vi.mock('../src/config',()=>({default:{bankStorageDir:'/tmp/eqfal-bank-test'}}));
vi.mock('../src/storage/local.storage',()=>({LocalStorageAdapter:class{get=mocks.storageGet;}}));
vi.mock('../src/modules/auth/auth.middleware',()=>({
  getAuthenticatedContext:vi.fn(()=>mocks.context),
  requireAuth:(_req:Request,res:Response,next:NextFunction)=>mocks.context?next():void res.status(401).json({error:'Unauthenticated'}),
  requireActiveCompany:(_req:Request,res:Response,next:NextFunction)=>mocks.context?.activeCompanyId?next():void res.status(403).json({error:'No active company'}),
  requireCapability:(capability:string)=>(_req:Request,res:Response,next:NextFunction)=>mocks.context?.capabilities.includes(capability)?next():void res.status(403).json({error:'Forbidden'}),
}));

import { bankImportResumeRouter } from '../src/modules/banking/bank-import-resume.router';

const app=express();app.use('/api',bankImportResumeRouter);app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>res.status(500).json({error:err instanceof Error?err.message:'error'}));
const csv=Buffer.from('Date,Amount\n2026-08-01,5.00\n2026-08-02,-1.00\n');
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const batch={id:'b1',company_id:'co-a',bank_account_id:'a1',original_filename:'statement.csv',source_format:'csv',storage_key:'co-a/file',file_sha256:sha(csv),status:'mapping_required'};
function setContext(capabilities:string[],companyId:string|null='co-a'){mocks.context={user:{id:'u1',email:'u@example.com'},allowedCompanies:[{id:'co-a',name:'A',name_ar:null}],activeCompanyId:companyId,capabilities};}

beforeEach(()=>{mocks.context=null;mocks.query.mockReset();mocks.storageGet.mockReset();});

describe('bank import resume',()=>{
  it('requires bank.import',async()=>{setContext([]);expect((await request(app).get('/api/bank-import-batches/b1/resume')).status).toBe(403);});

  it('resumes a mapping-required batch and returns detected columns',async()=>{
    setContext(['bank.import']);mocks.query.mockResolvedValueOnce({rows:[batch]});mocks.storageGet.mockResolvedValueOnce(csv);
    const res=await request(app).get('/api/bank-import-batches/b1/resume');
    expect(res.status).toBe(200);expect(res.body.batch.id).toBe('b1');expect(res.body.columns).toEqual(['Date','Amount']);expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('id=$1 AND company_id=$2'),['b1','co-a']);
  });

  it('returns safe 404 for a batch outside the active company',async()=>{
    setContext(['bank.import']);mocks.query.mockResolvedValueOnce({rows:[]});
    const res=await request(app).get('/api/bank-import-batches/other/resume');
    expect(res.status).toBe(404);expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it('does not resume confirmed imports',async()=>{
    setContext(['bank.import']);mocks.query.mockResolvedValueOnce({rows:[{...batch,status:'confirmed'}]});
    const res=await request(app).get('/api/bank-import-batches/b1/resume');
    expect(res.status).toBe(409);expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it('fails safely when the stored file cannot be parsed',async()=>{
    setContext(['bank.import']);const junk=Buffer.from('not a bank statement');mocks.query.mockResolvedValueOnce({rows:[{...batch,file_sha256:sha(junk)}]});mocks.storageGet.mockResolvedValueOnce(junk);
    const res=await request(app).get('/api/bank-import-batches/b1/resume');
    expect(res.status).toBe(409);expect(res.body.error).toBe('Stored bank import cannot be resumed');
  });
  it('does not expose the stored checksum in the response',async()=>{
    setContext(['bank.import']);mocks.query.mockResolvedValueOnce({rows:[batch]});mocks.storageGet.mockResolvedValueOnce(csv);
    const res=await request(app).get('/api/bank-import-batches/b1/resume');
    expect(res.status).toBe(200);expect(res.body.batch).not.toHaveProperty('file_sha256');
  });
  it('fails with a server error (not "cannot be resumed") when the stored file fails SHA-256 verification',async()=>{
    setContext(['bank.import']);mocks.query.mockResolvedValueOnce({rows:[batch]});mocks.storageGet.mockResolvedValueOnce(Buffer.from('Date,Amount\n2026-08-01,999.00\n'));
    const res=await request(app).get('/api/bank-import-batches/b1/resume');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
