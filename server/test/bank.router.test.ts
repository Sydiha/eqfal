import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as null | { user:{id:string;email:string}; allowedCompanies:{id:string;name:string;name_ar:string|null}[]; activeCompanyId:string|null; capabilities:string[] },
  query: vi.fn(), connect: vi.fn(), storagePut: vi.fn(), storageGet: vi.fn(), storageDelete: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({ default: { query: mocks.query, connect: mocks.connect } }));
vi.mock('../src/config', () => ({ default: { bankStorageDir: '/tmp/eqfal-bank-test' } }));
vi.mock('../src/storage/local.storage', () => ({ LocalStorageAdapter: class { put=mocks.storagePut; get=mocks.storageGet; delete=mocks.storageDelete; } }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => mocks.context),
  requireAuth: (_req:Request,res:Response,next:NextFunction) => mocks.context ? next() : void res.status(401).json({error:'Unauthenticated'}),
  requireActiveCompany: (_req:Request,res:Response,next:NextFunction) => mocks.context?.activeCompanyId ? next() : void res.status(403).json({error:'No active company'}),
  requireCapability: (capability:string) => (_req:Request,res:Response,next:NextFunction) => mocks.context?.capabilities.includes(capability) ? next() : void res.status(403).json({error:'Forbidden'}),
}));

import { bankRouter, parseBankFile } from '../src/modules/banking/bank.router';

const app=express(); app.use(express.json()); app.use('/api',bankRouter); app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>res.status(500).json({error:err instanceof Error?err.message:'error'}));
const account={id:'a1',company_id:'co-a',display_name:'Main',bank_name:'Bank',currency_code:'SAR',is_active:true,created_by:'u1',created_at:new Date(),updated_at:new Date()};
const batch={id:'b1',company_id:'co-a',bank_account_id:'a1',original_filename:'statement.csv',mime_type:'text/csv',source_format:'csv',storage_key:'co-a/file',file_sha256:'x',status:'preview_ready',column_mapping:null,total_rows:0,valid_rows:0,duplicate_rows:0,invalid_rows:0,created_by:'u1',created_at:new Date(),confirmed_by:null,confirmed_at:null};
function setContext(capabilities:string[],companyId:string|null='co-a'){mocks.context={user:{id:'u1',email:'u@example.com'},allowedCompanies:[{id:'co-a',name:'A',name_ar:null}],activeCompanyId:companyId,capabilities};}
const csv=Buffer.from('Date,Description,Amount,Reference\n2026-08-01,Sale,100.00,R1\n2026-08-02,Fee,-5.25,R2\n');
function upload(){return request(app).post('/api/bank-import-batches').set('Content-Type','text/csv').set('X-File-Name',encodeURIComponent('statement.csv')).set('X-Bank-Account-Id','a1').send(csv);}

function zip(entries:Record<string,string>):Buffer{
  const locals:Buffer[]=[]; const centrals:Buffer[]=[]; let offset=0;
  for(const [name,text] of Object.entries(entries)){
    const n=Buffer.from(name); const d=Buffer.from(text); const local=Buffer.alloc(30); local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,6);local.writeUInt16LE(0,8);local.writeUInt32LE(0,14);local.writeUInt32LE(d.length,18);local.writeUInt32LE(d.length,22);local.writeUInt16LE(n.length,26);locals.push(local,n,d);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0,8);central.writeUInt16LE(0,10);central.writeUInt32LE(0,16);central.writeUInt32LE(d.length,20);central.writeUInt32LE(d.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42);centrals.push(central,n);offset+=30+n.length+d.length;
  }
  const centralStart=offset; const centralData=Buffer.concat(centrals); const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(centralData.length,12);end.writeUInt32LE(centralStart,16);return Buffer.concat([...locals,centralData,end]);
}

describe('Bank API security boundary',()=>{
  beforeEach(()=>{mocks.context=null;mocks.query.mockReset();mocks.connect.mockReset();mocks.storagePut.mockReset();mocks.storageGet.mockReset();mocks.storageDelete.mockReset();});
  it('requires authentication and active company',async()=>{expect((await request(app).get('/api/bank-accounts')).status).toBe(401);setContext(['bank.view'],null);expect((await request(app).get('/api/bank-accounts')).status).toBe(403);});
  it('requires independent capabilities',async()=>{setContext([]);expect((await request(app).get('/api/bank-accounts')).status).toBe(403);expect((await upload()).status).toBe(403);expect((await request(app).post('/api/bank-accounts').send({display_name:'Main',currency_code:'SAR'})).status).toBe(403);});
  it('scopes list queries to the server-trusted active company',async()=>{setContext(['bank.view']);mocks.query.mockResolvedValueOnce({rows:[account]});const res=await request(app).get('/api/bank-accounts?company_id=co-b');expect(res.status).toBe(200);expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('company_id=$1'),['co-a']);});
  it('rejects cross-origin bank mutations',async()=>{setContext(['bank.import']);const res=await upload().set('Origin','https://evil.example');expect(res.status).toBe(403);expect(mocks.query).not.toHaveBeenCalled();});
  it('rejects invalid file type and signature before database writes',async()=>{setContext(['bank.import']);const bad=await request(app).post('/api/bank-import-batches').set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('X-File-Name',encodeURIComponent('statement.xlsx')).set('X-Bank-Account-Id','a1').send(Buffer.from('not-zip'));expect(bad.status).toBe(400);expect(mocks.query).not.toHaveBeenCalled();});
  it('returns safe 404 when account belongs to another company',async()=>{setContext(['bank.import']);mocks.query.mockResolvedValueOnce({rows:[]});const res=await upload();expect(res.status).toBe(404);expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('id=$1 AND company_id=$2'),['a1','co-a']);expect(mocks.storagePut).not.toHaveBeenCalled();});
  it('blocks exact duplicate files before storage write',async()=>{setContext(['bank.import']);mocks.query.mockResolvedValueOnce({rows:[account]}).mockResolvedValueOnce({rows:[batch]});const res=await upload();expect(res.status).toBe(409);expect(res.body.existingBatchId).toBe('b1');expect(mocks.storagePut).not.toHaveBeenCalled();});
  it('rejects oversized files in the raw parser',async()=>{setContext(['bank.import']);const big=Buffer.alloc(5*1024*1024+1,0x31);const res=await request(app).post('/api/bank-import-batches').set('Content-Type','text/csv').set('X-File-Name',encodeURIComponent('big.csv')).set('X-Bank-Account-Id','a1').send(big);expect(res.status).toBe(413);});
});

describe('Bank file parsing',()=>{
  it('parses CSV headers and data without external dependencies',()=>{const table=parseBankFile('csv',csv);expect(table.headers).toEqual(['Date','Description','Amount','Reference']);expect(table.rows).toHaveLength(2);expect(table.rows[0]?.[2]).toBe('100.00');});
  it('supports UTF-16LE CSV with BOM',()=>{const data=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('Date,Amount\n2026-08-01,5.00\n','utf16le')]);const table=parseBankFile('csv',data);expect(table.rows[0]?.[1]).toBe('5.00');});
  it('rejects more than 10,000 data rows',()=>{const rows=['Date,Amount',...Array.from({length:10001},(_,i)=>`2026-08-01,${i+1}`)].join('\n');expect(()=>parseBankFile('csv',Buffer.from(rows))).toThrow(/row limit/);});
  it('parses the first XLSX worksheet and flags formula cells',()=>{
    const data=zip({
      'xl/workbook.xml':'<workbook xmlns:r="r"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Date</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>2026-08-01</t></is></c><c r="B2"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>'
    });
    const table=parseBankFile('xlsx',data);expect(table.headers).toEqual(['Date','Amount']);expect(table.rows[0]?.[1]).toBe(2);expect(table.formulaCells.has('0:1')).toBe(true);
  });
});
