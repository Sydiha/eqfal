import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: null as null | { user:{id:string;email:string}; allowedCompanies:{id:string;name:string;name_ar:string|null}[]; activeCompanyId:string|null; capabilities:string[] },
  query: vi.fn(), connect: vi.fn(), storagePut: vi.fn(), storageGet: vi.fn(), storageDelete: vi.fn(), auditLogEvent: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({ default: { query: mocks.query, connect: mocks.connect } }));
vi.mock('../src/config', () => ({ default: { bankStorageDir: '/tmp/eqfal-bank-test' } }));
vi.mock('../src/storage/local.storage', () => ({ LocalStorageAdapter: class { put=mocks.storagePut; get=mocks.storageGet; delete=mocks.storageDelete; } }));
vi.mock('../src/modules/audit-log/audit-log.repository', () => ({ AuditLogRepository: class { logEvent=mocks.auditLogEvent; } }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => mocks.context),
  requireAuth: (_req:Request,res:Response,next:NextFunction) => mocks.context ? next() : void res.status(401).json({error:'Unauthenticated'}),
  requireActiveCompany: (_req:Request,res:Response,next:NextFunction) => mocks.context?.activeCompanyId ? next() : void res.status(403).json({error:'No active company'}),
  requireCapability: (capability:string) => (_req:Request,res:Response,next:NextFunction) => mocks.context?.capabilities.includes(capability) ? next() : void res.status(403).json({error:'Forbidden'}),
}));

import { BankService, bankRouter, parseBankFile } from '../src/modules/banking/bank.router';

const app=express(); app.use(express.json()); app.use('/api',bankRouter); app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>res.status(500).json({error:err instanceof Error?err.message:'error'}));
const account={id:'a1',company_id:'co-a',display_name:'Main',bank_name:'Bank',currency_code:'SAR',is_active:true,created_by:'u1',created_at:new Date(),updated_at:new Date()};
const inactiveAccount={...account,is_active:false};
const mapping={amount_mode:'signed' as const,date_format:'YYYY-MM-DD' as const,transaction_date:{index:0,label:'Date'},amount:{index:2,label:'Amount'},description:{index:1,label:'Description'},bank_reference:{index:3,label:'Reference'}};
const batch={id:'b1',company_id:'co-a',bank_account_id:'a1',original_filename:'statement.csv',mime_type:'text/csv',source_format:'csv' as const,storage_key:'co-a/file',file_sha256:'x',status:'preview_ready' as const,column_mapping:mapping,total_rows:2,valid_rows:2,duplicate_rows:0,invalid_rows:0,created_by:'u1',created_at:new Date(),confirmed_by:null,confirmed_at:null};
const confirmedBatch={...batch,status:'confirmed' as const,confirmed_by:'u1',confirmed_at:new Date()};
function setContext(capabilities:string[],companyId:string|null='co-a'){mocks.context={user:{id:'u1',email:'u@example.com'},allowedCompanies:[{id:'co-a',name:'A',name_ar:null}],activeCompanyId:companyId,capabilities};}
const csv=Buffer.from('Date,Description,Amount,Reference\n2026-08-01,Sale,100.00,R1\n2026-08-02,Fee,-5.25,R2\n');
function upload(){return request(app).post('/api/bank-import-batches').set('Content-Type','text/csv').set('X-File-Name',encodeURIComponent('statement.csv')).set('X-Bank-Account-Id','a1').send(csv);}
function makeClient(handler:(sql:string,params?:unknown[])=>unknown|Promise<unknown>){return {query:vi.fn((sql:string,params?:unknown[])=>Promise.resolve(handler(sql,params))),release:vi.fn()};}

function zip(entries:Record<string,string>):Buffer{
  const locals:Buffer[]=[]; const centrals:Buffer[]=[]; let offset=0;
  for(const [name,text] of Object.entries(entries)){
    const n=Buffer.from(name); const d=Buffer.from(text); const local=Buffer.alloc(30); local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,6);local.writeUInt16LE(0,8);local.writeUInt32LE(0,14);local.writeUInt32LE(d.length,18);local.writeUInt32LE(d.length,22);local.writeUInt16LE(n.length,26);locals.push(local,n,d);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0,8);central.writeUInt16LE(0,10);central.writeUInt32LE(0,16);central.writeUInt32LE(d.length,20);central.writeUInt32LE(d.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42);centrals.push(central,n);offset+=30+n.length+d.length;
  }
  const centralStart=offset; const centralData=Buffer.concat(centrals); const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(centralData.length,12);end.writeUInt32LE(centralStart,16);return Buffer.concat([...locals,centralData,end]);
}

function formulaXlsx():Buffer{return zip({
  'xl/workbook.xml':'<workbook xmlns:r="r"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Date</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>2026-08-01</t></is></c><c r="B2"><f>1+1</f><v>2</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>2026-08-02</t></is></c><c r="B3"><v>3</v></c></row></sheetData></worksheet>'
});}

beforeEach(()=>{
  mocks.context=null; mocks.query.mockReset(); mocks.connect.mockReset(); mocks.storagePut.mockReset(); mocks.storageGet.mockReset(); mocks.storageDelete.mockReset(); mocks.auditLogEvent.mockReset();
  mocks.auditLogEvent.mockResolvedValue({});
});

describe('Bank API security boundary',()=>{
  it('requires authentication',async()=>{expect((await request(app).get('/api/bank-accounts')).status).toBe(401);});
  it('requires an active company',async()=>{setContext(['bank.view'],null);expect((await request(app).get('/api/bank-accounts')).status).toBe(403);});
  it('requires bank.view for read APIs',async()=>{setContext([]);expect((await request(app).get('/api/bank-accounts')).status).toBe(403);expect((await request(app).get('/api/bank-transactions')).status).toBe(403);});
  it('requires bank.import for import APIs',async()=>{setContext([]);expect((await upload()).status).toBe(403);expect((await request(app).get('/api/bank-import-batches/b1/preview')).status).toBe(403);expect((await request(app).post('/api/bank-import-batches/b1/confirm')).status).toBe(403);});
  it('requires bank.account.manage and permits an authorized create',async()=>{
    setContext([]);expect((await request(app).post('/api/bank-accounts').send({display_name:'Main',currency_code:'SAR'})).status).toBe(403);
    setContext(['bank.account.manage']);
    const client=makeClient((sql)=>sql==='BEGIN'||sql==='COMMIT'?{rows:[]} : sql.includes('INSERT INTO bank_accounts')?{rows:[account]}:{rows:[]}); mocks.connect.mockResolvedValue(client);
    expect((await request(app).post('/api/bank-accounts').send({display_name:'Main',currency_code:'SAR'})).status).toBe(201);
  });
  it('scopes account lists to the server-trusted active company',async()=>{setContext(['bank.view']);mocks.query.mockResolvedValueOnce({rows:[account]});const res=await request(app).get('/api/bank-accounts?company_id=co-b');expect(res.status).toBe(200);expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('company_id=$1'),['co-a']);});
  it('scopes transaction lists to the server-trusted active company',async()=>{setContext(['bank.view']);mocks.query.mockResolvedValueOnce({rows:[]});const res=await request(app).get('/api/bank-transactions?company_id=co-b');expect(res.status).toBe(200);expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('company_id=$1'),['co-a']);});
  it('does not accept a forged company_id in bank-account creation',async()=>{setContext(['bank.account.manage']);const res=await request(app).post('/api/bank-accounts').send({display_name:'Main',currency_code:'SAR',company_id:'co-b'});expect(res.status).toBe(400);expect(mocks.connect).not.toHaveBeenCalled();});
  it('returns safe 404 when an import account belongs to another company',async()=>{setContext(['bank.import']);mocks.query.mockResolvedValueOnce({rows:[]});const res=await upload();expect(res.status).toBe(404);expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('id=$1 AND company_id=$2'),['a1','co-a']);expect(mocks.storagePut).not.toHaveBeenCalled();});
  it('returns safe 404 for cross-company preview batch ids',async()=>{setContext(['bank.import']);mocks.query.mockResolvedValueOnce({rows:[]});const res=await request(app).get('/api/bank-import-batches/other/preview');expect(res.status).toBe(404);expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('id=$1 AND company_id=$2'),['other','co-a']);});
  it('returns safe 404 for cross-company confirm batch ids',async()=>{setContext(['bank.import']);const client=makeClient((sql)=>sql==='BEGIN'||sql==='ROLLBACK'?{rows:[]} : sql.includes('FROM bank_import_batches')?{rows:[]}:{rows:[]});mocks.connect.mockResolvedValue(client);const res=await request(app).post('/api/bank-import-batches/other/confirm');expect(res.status).toBe(404);expect(client.query).toHaveBeenCalledWith(expect.stringContaining('id=$1 AND company_id=$2 FOR UPDATE'),['other','co-a']);});
  it('rejects cross-origin bank mutations',async()=>{setContext(['bank.import']);const res=await upload().set('Origin','https://evil.example');expect(res.status).toBe(403);expect(mocks.query).not.toHaveBeenCalled();});
  it('blocks exact duplicate files before storage write',async()=>{setContext(['bank.import']);mocks.query.mockResolvedValueOnce({rows:[account]}).mockResolvedValueOnce({rows:[batch]});const res=await upload();expect(res.status).toBe(409);expect(res.body.existingBatchId).toBe('b1');expect(mocks.storagePut).not.toHaveBeenCalled();});
  it('blocks imports to inactive accounts',async()=>{setContext(['bank.import']);mocks.query.mockResolvedValueOnce({rows:[inactiveAccount]});const res=await upload();expect(res.status).toBe(409);expect(mocks.storagePut).not.toHaveBeenCalled();});
  it('blocks confirmation when the bank account became inactive',async()=>{setContext(['bank.import']);const client=makeClient((sql)=>{if(sql==='BEGIN'||sql==='ROLLBACK')return {rows:[]};if(sql.includes('FROM bank_import_batches'))return {rows:[batch]};if(sql.includes('FROM bank_accounts'))return {rows:[inactiveAccount]};return {rows:[]};});mocks.connect.mockResolvedValue(client);const res=await request(app).post('/api/bank-import-batches/b1/confirm');expect(res.status).toBe(409);expect(client.query).toHaveBeenCalledWith('ROLLBACK');});
});

describe('Bank import validation and duplicate semantics',()=>{
  it('rejects invalid file type and XLSX signature before database writes',async()=>{setContext(['bank.import']);const bad=await request(app).post('/api/bank-import-batches').set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('X-File-Name',encodeURIComponent('statement.xlsx')).set('X-Bank-Account-Id','a1').send(Buffer.from('not-zip'));expect(bad.status).toBe(400);expect(mocks.query).not.toHaveBeenCalled();});
  it('rejects oversized files in the raw parser',async()=>{setContext(['bank.import']);const big=Buffer.alloc(5*1024*1024+1,0x31);const res=await request(app).post('/api/bank-import-batches').set('Content-Type','text/csv').set('X-File-Name',encodeURIComponent('big.csv')).set('X-Bank-Account-Id','a1').send(big);expect(res.status).toBe(413);});
  it('rejects more than 10,000 data rows',()=>{const rows=['Date,Amount',...Array.from({length:10001},(_,i)=>`2026-08-01,${i+1}`)].join('\n');expect(()=>parseBankFile('csv',Buffer.from(rows))).toThrow(/row limit/);});
  it('marks mapped XLSX formula cells invalid',async()=>{
    const formulaBatch={...batch,source_format:'xlsx' as const,storage_key:'co-a/formula',column_mapping:{amount_mode:'signed' as const,date_format:'YYYY-MM-DD' as const,transaction_date:{index:0},amount:{index:1}}};
    const fakeDb={query:vi.fn().mockResolvedValueOnce({rows:[formulaBatch]}).mockResolvedValueOnce({rows:[account]}).mockResolvedValueOnce({rows:[]})};
    const files={get:vi.fn().mockResolvedValue(formulaXlsx()),put:vi.fn(),delete:vi.fn()};
    const service=new BankService(fakeDb as never,files as never); const result=await service.preview('b1','co-a');
    expect(result.invalidRows).toBe(1);expect(result.rows[0]?.error).toBe('Formula cells are not allowed');
  });
  it('treats an existing strong fingerprint as a non-insertable duplicate',async()=>{
    const fakeDb={query:vi.fn().mockResolvedValueOnce({rows:[batch]}).mockResolvedValueOnce({rows:[account]}).mockImplementationOnce((_sql:string,params:unknown[])=>({rows:[{fingerprint:(params[2] as string[])[0]}]}))};
    const files={get:vi.fn().mockResolvedValue(csv),put:vi.fn(),delete:vi.fn()};const result=await new BankService(fakeDb as never,files as never).preview('b1','co-a');
    expect(result.duplicateRows).toBe(1);expect(result.rows[0]?.status).toBe('duplicate');
  });
  it('treats an existing weak fingerprint only as a possible duplicate',async()=>{
    const weakBatch={...batch,column_mapping:{amount_mode:'signed' as const,date_format:'YYYY-MM-DD' as const,transaction_date:{index:0},amount:{index:2},description:{index:1}}};
    const fakeDb={query:vi.fn().mockResolvedValueOnce({rows:[weakBatch]}).mockResolvedValueOnce({rows:[account]}).mockImplementationOnce((_sql:string,params:unknown[])=>({rows:[{fingerprint:(params[2] as string[])[0]}]}))};
    const files={get:vi.fn().mockResolvedValue(csv),put:vi.fn(),delete:vi.fn()};const result=await new BankService(fakeDb as never,files as never).preview('b1','co-a');
    expect(result.possibleDuplicateRows).toBe(1);expect(result.rows[0]?.status).toBe('possible_duplicate');expect(result.validRows).toBe(2);
  });
});

describe('Bank confirmation transaction guarantees',()=>{
  it('is idempotent when the same batch is confirmed twice',async()=>{
    let confirmed=false;let insertCount=0;
    const client=makeClient((sql)=>{
      if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[]};
      if(sql.includes('FROM bank_import_batches'))return {rows:[confirmed?confirmedBatch:batch]};
      if(sql.includes('FROM bank_accounts'))return {rows:[account]};
      if(sql.includes('SELECT DISTINCT fingerprint'))return {rows:[]};
      if(sql.includes('INSERT INTO bank_transactions')){insertCount++;return {rows:[],rowCount:1};}
      if(sql.includes("UPDATE bank_import_batches SET status='confirmed'")){confirmed=true;return {rows:[confirmedBatch]};}
      return {rows:[]};
    });
    const fakeDb={connect:vi.fn().mockResolvedValue(client)};const files={get:vi.fn().mockResolvedValue(csv),put:vi.fn(),delete:vi.fn()};const service=new BankService(fakeDb as never,files as never);
    const first=await service.confirm('b1','co-a','u1');const second=await service.confirm('b1','co-a','u1');
    expect(first.idempotent).toBe(false);expect(first.importedRows).toBe(2);expect(second.idempotent).toBe(true);expect(insertCount).toBe(2);expect(files.get).toHaveBeenCalledTimes(1);
  });
  it('rolls back the whole confirmation transaction when audit logging fails',async()=>{
    mocks.auditLogEvent.mockRejectedValueOnce(new Error('audit unavailable'));
    const client=makeClient((sql)=>{
      if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[]};
      if(sql.includes('FROM bank_import_batches'))return {rows:[batch]};
      if(sql.includes('FROM bank_accounts'))return {rows:[account]};
      if(sql.includes('SELECT DISTINCT fingerprint'))return {rows:[]};
      if(sql.includes('INSERT INTO bank_transactions'))return {rows:[],rowCount:1};
      if(sql.includes("UPDATE bank_import_batches SET status='confirmed'"))return {rows:[confirmedBatch]};
      return {rows:[]};
    });
    const fakeDb={connect:vi.fn().mockResolvedValue(client)};const files={get:vi.fn().mockResolvedValue(csv),put:vi.fn(),delete:vi.fn()};const service=new BankService(fakeDb as never,files as never);
    await expect(service.confirm('b1','co-a','u1')).rejects.toThrow('audit unavailable');expect(client.query).toHaveBeenCalledWith('ROLLBACK');expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  });
});

describe('Bank file parsing',()=>{
  it('parses CSV headers and data without external dependencies',()=>{const table=parseBankFile('csv',csv);expect(table.headers).toEqual(['Date','Description','Amount','Reference']);expect(table.rows).toHaveLength(2);expect(table.rows[0]?.[2]).toBe('100.00');});
  it('supports UTF-16LE CSV with BOM',()=>{const data=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('Date,Amount\n2026-08-01,5.00\n2026-08-02,-1.00\n','utf16le')]);const table=parseBankFile('csv',data);expect(table.rows[0]?.[1]).toBe('5.00');});
  it('parses the first XLSX worksheet and tracks formula cells',()=>{const table=parseBankFile('xlsx',formulaXlsx());expect(table.headers).toEqual(['Date','Amount']);expect(table.rows[0]?.[1]).toBe(2);expect(table.formulaCells.has('0:1')).toBe(true);});
});
