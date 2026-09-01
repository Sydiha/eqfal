import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

const company='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const journalId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const yearId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const sourceId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const mocks=vi.hoisted(()=>({enforce:vi.fn(),audit:vi.fn()}));
vi.mock('../src/modules/accounting/vat-recognition',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('../src/modules/accounting/vat-recognition')>();
 return{...actual,enforceVatRecognition:mocks.enforce};
});
vi.mock('../src/modules/audit-log/audit-log.repository',()=>({AuditLogRepository:class{logEvent=(event:unknown,client:unknown)=>mocks.audit(event,client)}}));

const{AccountingService}=await import('../src/modules/accounting/accounting.router');
const{VatRecognitionIncompleteError}=await import('../src/modules/accounting/vat-recognition');

type Result={rows:Record<string,unknown>[];rowCount:number};
const result=(rows:Record<string,unknown>[]=[]):Result=>({rows,rowCount:rows.length});

function postingPool(){
 const commands:string[]=[];
 const journal={id:journalId,company_id:company,fiscal_year_id:yearId,accounting_date:'2026-09-10',description:'Purchase recognition',reference:null,source_type:'obligation',source_id:sourceId,entry_type:'standard',status:'draft',created_by:actor,posted_by:null,posted_at:null,created_at:new Date(),updated_at:new Date()};
 const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
  const q=sql.replace(/\s+/g,' ');commands.push(q);
  if(q==='BEGIN'||q==='COMMIT'||q==='ROLLBACK'||q.includes('pg_advisory_xact_lock'))return result();
  if(q.includes('FROM journal_entries WHERE id=$1 AND company_id=$2 FOR UPDATE'))return args[0]===journalId&&args[1]===company?result([journal]):result();
  if(q.includes('FROM fiscal_years WHERE id=$1 AND company_id=$2'))return result([{start_date:'2026-01-01',end_date:'2026-12-31'}]);
  if(q.includes('FROM monthly_close_periods'))return result();
  if(q.includes('COUNT(*)::text count')&&q.includes('FROM journal_lines'))return result([{count:'3',debit:'1150.00',credit:'1150.00',active:'3'}]);
  if(q.includes("FROM obligations o JOIN counterparties"))return result([{source_type:'obligation',source_id:sourceId,accounting_date:'2026-09-10',amount:'1150.00',description:'Obligation: Supplier',reference:null,context:{document_id:'ffffffff-ffff-4fff-8fff-ffffffffffff'}}]);
  if(q.startsWith('SELECT $1::numeric(18,2)=$2::numeric(18,2) matches'))return result([{matches:true}]);
  if(q.startsWith("UPDATE journal_entries SET status='posted'"))return result([{...journal,status:'posted',posted_by:actor,posted_at:new Date('2026-09-11T00:00:00Z')}]);
  throw new Error(q);
 });
 const client={query,release:vi.fn()} as unknown as PoolClient;
 return{pool:{connect:vi.fn().mockResolvedValue(client),query} as unknown as Pool,query,commands,client};
}

describe('AccountingService VAT posting boundary',()=>{
 it('enforces VAT recognition before posting a recognition journal',async()=>{
  mocks.enforce.mockReset().mockResolvedValue({memo:'VAT_INPUT'});mocks.audit.mockReset().mockResolvedValue({});
  const built=postingPool();
  await expect(new AccountingService(built.pool).post(company,actor,journalId)).resolves.toMatchObject({status:'posted'});
  expect(mocks.enforce).toHaveBeenCalledWith(company,journalId,'obligation',sourceId,built.client);
  expect(built.commands.findIndex(q=>q.startsWith("UPDATE journal_entries SET status='posted'"))).toBeGreaterThan(built.commands.findIndex(q=>q.startsWith('SELECT $1::numeric')));
  expect(built.commands).toContain('COMMIT');
 });

 it('rolls back and keeps the journal draft when VAT recognition is incomplete',async()=>{
  mocks.enforce.mockReset().mockRejectedValue(new VatRecognitionIncompleteError());mocks.audit.mockReset();
  const built=postingPool();
  await expect(new AccountingService(built.pool).post(company,actor,journalId)).rejects.toBeInstanceOf(VatRecognitionIncompleteError);
  expect(built.commands.some(q=>q.startsWith("UPDATE journal_entries SET status='posted'"))).toBe(false);
  expect(built.commands).toContain('ROLLBACK');
  expect(mocks.audit).not.toHaveBeenCalled();
 });
});
