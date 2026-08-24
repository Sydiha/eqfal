import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';

const audit=vi.fn();
vi.mock('../src/modules/audit-log/audit-log.repository',()=>({AuditLogRepository:class{logEvent=async(...args:unknown[])=>audit(...args)}}));
vi.mock('../src/modules/monthly-close/accounting-period.guard',()=>({AccountingPeriodClosedError:class extends Error{},assertAccountingDateWritable:vi.fn().mockResolvedValue(undefined),lockAccountingRange:vi.fn().mockResolvedValue(undefined)}));

const {ObligationService}=await import('../src/modules/obligations/obligation.router');

const COMPANY='11111111-1111-4111-8111-111111111111';
const USER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOCUMENT='22222222-2222-4222-8222-222222222222';
const COUNTERPARTY='33333333-3333-4333-8333-333333333333';

function dbFor(documentType:'sale'|'purchase'|'expense',counterpartyType:'customer'|'supplier'){
 const queries:string[]=[];
 const handler=(sql:string)=>{
  const normalized=sql.replace(/\s+/g,' ');queries.push(normalized);
  if(['BEGIN','COMMIT','ROLLBACK'].includes(normalized))return{rows:[],rowCount:0};
  if(normalized.includes('SELECT type FROM counterparties'))return{rows:[{type:counterpartyType}],rowCount:1};
  if(normalized.includes('FROM documents'))return{rows:[{status:'approved',document_type:documentType,document_date:'2026-08-24',total_amount:'100.00',counterparty_id:COUNTERPARTY}],rowCount:1};
  if(normalized.includes('FROM custody_document_allocations'))return{rows:[],rowCount:0};
  if(normalized.startsWith('INSERT INTO obligations'))return{rows:[{id:'ob-1',company_id:COMPANY,direction:documentType==='sale'?'receivable':'payable',counterparty_id:COUNTERPARTY,document_id:DOCUMENT,original_amount:'100.00',recognized_on:'2026-08-24',due_on:null,verification_status:'unconfirmed',source_type:'document',source_note:null,is_cancelled:false,version:1}],rowCount:1};
  throw new Error(normalized);
 };
 const client={query:vi.fn((sql:string)=>handler(sql)),release:vi.fn()};
 const db={connect:vi.fn().mockResolvedValue(client)} as unknown as Pool;
 return{db,queries};
}

const input=(documentType:'sale'|'purchase'|'expense')=>({
 direction:documentType==='sale'?'receivable':'payable',counterparty_id:COUNTERPARTY,document_id:DOCUMENT,original_amount:'100.00',recognized_on:'2026-08-24',due_on:null,verification_status:'unconfirmed',source_type:'document',source_note:null,
});

beforeEach(()=>audit.mockReset());

describe('document-backed obligation counterparty role integrity',()=>{
 it.each([
  ['purchase','customer'],
  ['expense','customer'],
  ['sale','supplier'],
 ] as const)('rejects %s obligations linked to a %s',async(documentType,counterpartyType)=>{
  const {db,queries}=dbFor(documentType,counterpartyType);
  await expect(new ObligationService(db).createObligation(COMPANY,USER,input(documentType))).rejects.toThrow();
  expect(queries.some(query=>query.startsWith('INSERT INTO obligations'))).toBe(false);
  expect(audit).not.toHaveBeenCalled();
 });

 it.each([
  ['purchase','supplier'],
  ['expense','supplier'],
  ['sale','customer'],
 ] as const)('allows %s obligations linked to a %s',async(documentType,counterpartyType)=>{
  const {db,queries}=dbFor(documentType,counterpartyType);
  await expect(new ObligationService(db).createObligation(COMPANY,USER,input(documentType))).resolves.toMatchObject({document_id:DOCUMENT,counterparty_id:COUNTERPARTY});
  expect(queries.some(query=>query.startsWith('INSERT INTO obligations'))).toBe(true);
  expect(audit).toHaveBeenCalledOnce();
 });
});
