import express,{NextFunction,Request,Response}from'express';import request from'supertest';import{beforeEach,describe,expect,it,vi}from'vitest';
const USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',COMPANY='11111111-1111-4111-8111-111111111111',O='22222222-2222-4222-8222-222222222222',BANK='33333333-3333-4333-8333-333333333333';
const mocks=vi.hoisted(()=>({context:null as any,audit:vi.fn(),pool:null as any}));
vi.mock('../src/db/pool',()=>({get default(){return mocks.pool}}));vi.mock('../src/modules/audit-log/audit-log.repository',()=>({AuditLogRepository:class{logEvent=async(e:unknown,c:unknown)=>mocks.audit(e,c)}}));vi.mock('../src/modules/auth/origin.middleware',()=>({requireSameOrigin:(_q:Request,_s:Response,n:NextFunction)=>n()}));vi.mock('../src/modules/auth/auth.middleware',()=>({getAuthenticatedContext:()=>mocks.context,requireAuth:(_q:Request,s:Response,n:NextFunction)=>mocks.context?n():void s.status(401).end(),requireActiveCompany:(_q:Request,s:Response,n:NextFunction)=>mocks.context?.activeCompanyId?n():void s.status(403).end(),requireCapability:(c:string)=>(_q:Request,s:Response,n:NextFunction)=>mocks.context?.capabilities.includes(c)?n():void s.status(403).end()}));
vi.mock('../src/modules/monthly-close/accounting-period.guard',()=>({AccountingPeriodClosedError:class extends Error{},assertAccountingDateWritable:vi.fn().mockResolvedValue(undefined),lockAccountingRange:vi.fn().mockResolvedValue(undefined)}));
const mod=await import('../src/modules/obligations/obligation.router');const app=express();app.use(express.json());app.use('/api',mod.obligationRouter);app.use((_e:unknown,_q:Request,s:Response,_n:NextFunction)=>s.status(500).end());
import { bankingConflictBody } from '../src/modules/banking/banking-error-codes';
const ctx=(caps:string[])=>mocks.context={user:{id:USER},activeCompanyId:COMPANY,capabilities:caps};
const tx=['BEGIN','ROLLBACK','COMMIT'];
const ob=(over:Record<string,unknown>={})=>({id:O,company_id:COMPANY,source_type:'manual',direction:'receivable',original_amount:'100.00',is_cancelled:false,...over});
function run(o:Record<string,unknown>,bank:{amount:string}|null,opts:{linked?:boolean;prior?:string}={}){
  mocks.pool={query:vi.fn(),connect:vi.fn(async()=>({release:vi.fn(),query:async(s:string)=>{const sql=s.replace(/\s+/g,' ');
    if(tx.includes(sql))return{rows:[],rowCount:0};
    if(sql.includes('FROM obligations WHERE'))return{rows:[o],rowCount:1};
    if(sql.includes("source_type='obligation'"))return{rows:[],rowCount:0};
    if(sql.includes('FROM bank_transactions'))return bank?{rows:[{...bank,transaction_date:'2026-01-05'}],rowCount:1}:{rows:[],rowCount:0};
    if(sql.includes('FROM bank_transaction_matches'))return opts.linked?{rows:[{one:1}],rowCount:1}:{rows:[],rowCount:0};
    if(sql.includes('SUM(amount)'))return{rows:[{x:opts.prior??'0'}],rowCount:1};
    throw Error(sql);}}))};
}
const settle=(amount='60.00')=>request(app).post(`/api/obligations/${O}/settlements`).send({bank_transaction_id:BANK,amount});
beforeEach(()=>{mocks.context=null;mocks.pool=null});

describe('PR-2B obligations error codes',()=>{
  it('adds code FORBIDDEN to the requireAll 403 and keeps the message and outcome',async()=>{
    ctx([]);const res=await request(app).patch(`/api/obligations/${O}`).send({source_note:'x',version:1});
    expect(res.status).toBe(403);expect(res.body).toEqual({error:'Forbidden',code:'FORBIDDEN'});
  });
  it.each([
    ['document-sourced obligation',ob({source_type:'document'}),{amount:'60.00'},{},'OBLIGATION_SETTLEMENT_DOCUMENT_SOURCED'],
    ['cancelled obligation',ob({is_cancelled:true}),{amount:'60.00'},{},'OBLIGATION_CANCELLED'],
    ['direction mismatch',ob({direction:'payable'}),{amount:'60.00'},{},'OBLIGATION_BANK_DIRECTION_MISMATCH'],
    ['amount mismatch',ob(),{amount:'70.00'},{},'OBLIGATION_SETTLEMENT_AMOUNT_MISMATCH'],
    ['bank transaction already linked',ob(),{amount:'60.00'},{linked:true},'BANK_TRANSACTION_ALREADY_LINKED'],
    ['exceeds remaining',ob(),{amount:'60.00'},{prior:'50.00'},'OBLIGATION_SETTLEMENT_EXCEEDS_REMAINING'],
  ])('settle %s keeps 409 and message, adds code',async(_n,o,bank,opts,code)=>{
    ctx(['obligation.settlement.create']);run(o,bank,opts);const res=await settle();
    expect(res.status).toBe(409);expect(res.body).toEqual({error:'Conflict',code});
  });
  it('leaves unmapped conflicts code-free',async()=>{
    ctx(['obligation.settlement.create']);run(ob(),{amount:'60.00'});mocks.pool.connect=vi.fn(async()=>({release:vi.fn(),query:async(s:string)=>{if(tx.includes(s))return{rows:[],rowCount:0};throw Object.assign(new Error('dup'),{code:'23505'});}}));
    const res=await settle();expect(res.status).toBe(409);expect(res.body).toEqual({error:'Conflict'});
  });
});

describe('PR-2B banking conflict codes',()=>{
  it('adds a code and keeps the exact message',()=>{
    expect(bankingConflictBody('Allocations exceed the bank transaction amount')).toEqual({error:'Allocations exceed the bank transaction amount',code:'BANK_ALLOCATION_EXCEEDS_AMOUNT'});
    expect(bankingConflictBody('Bank transaction already has a settlement').code).toBe('BANK_TRANSACTION_ALREADY_SETTLED');
  });
  it('leaves unknown messages code-free',()=>{
    expect(bankingConflictBody('Document match is invalid')).toEqual({error:'Document match is invalid'});
  });
});
