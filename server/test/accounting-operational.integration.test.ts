import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AccountingConflictError, AccountingNotFoundError, AccountingService, AccountingValidationError } from '../src/modules/accounting/accounting.router';

const company='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherCompany='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sourceId='11111111-1111-4111-8111-111111111111';
const yearId='22222222-2222-4222-8222-222222222222';
const journalId='33333333-3333-4333-8333-333333333333';
const debitAccount='44444444-4444-4444-8444-444444444444';
const creditAccount='55555555-5555-4555-8555-555555555555';

type JournalState={id:string;company_id:string;fiscal_year_id:string;accounting_date:string;description:string;reference:null;source_type:string;source_id:string;entry_type:'standard';status:'draft'|'posted';posted_at:Date|null};
type LineState={id:string;company_id:string;journal_entry_id:string;account_id:string;debit:string;credit:string;memo:string|null;sequence:number};

class AccountingPool{
 journal:JournalState|null=null;
 lines:LineState[]=[];
 released=0;
 readonly source={source_type:'obligation' as const,source_id:sourceId,accounting_date:'2026-08-01',amount:'50.00',description:'Obligation: Supplier',reference:null,context:{direction:'payable'}};
 connect=async()=>({query:this.query,release:()=>{this.released++}});
 query=async(sql:string,values:unknown[]=[]):Promise<{rows:any[];rowCount:number}>=>{
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK'||sql.includes('pg_advisory_xact_lock'))return{rows:[],rowCount:0};
  if(sql.includes('FROM monthly_close_periods'))return{rows:[],rowCount:0};
  if(sql.includes('SELECT d.id FROM asset_depreciation_entries')||sql.includes('SELECT d.id FROM asset_disposals')||sql.includes('SELECT s.id FROM periodic_adjustment_schedule'))return{rows:[],rowCount:0};
  if(sql.includes("SELECT id FROM obligations"))return values[0]===company?{rows:[{id:sourceId}],rowCount:1}:{rows:[],rowCount:0};
  if(sql.includes('SELECT id FROM document_settlements')||sql.includes('SELECT id FROM obligation_settlements')||sql.includes('SELECT a.id FROM custody_document_allocations')||sql.includes('SELECT id FROM bank_transaction_matches'))return{rows:[],rowCount:0};
  if(sql.includes("FROM obligations o JOIN counterparties"))return values[0]===sourceId&&values[1]===company?{rows:[this.source],rowCount:1}:{rows:[],rowCount:0};
  if(sql.includes('SELECT d.id document_id')&&sql.includes('FROM obligations o'))return{rows:[],rowCount:0};
  if(sql.includes('SELECT 1 FROM journal_entries WHERE company_id=$1 AND source_type=$2 AND source_id=$3')){
   const found=this.journal?.company_id===values[0]&&this.journal.source_type===values[1]&&this.journal.source_id===values[2];
   return{rows:found?[{one:1}]:[],rowCount:found?1:0};
  }
  if(sql.includes('FROM fiscal_years WHERE id=$1 AND company_id=$2'))return values[0]===yearId&&values[1]===company?{rows:[{start_date:'2026-01-01',end_date:'2026-12-31'}],rowCount:1}:{rows:[],rowCount:0};
  if(sql.includes('INSERT INTO journal_entries')){
   this.journal={id:journalId,company_id:String(values[0]),fiscal_year_id:String(values[1]),accounting_date:String(values[2]),description:String(values[3]),reference:null,source_type:String(values[5]),source_id:String(values[6]),entry_type:'standard',status:'draft',posted_at:null};
   return{rows:[this.journal],rowCount:1};
  }
  if(sql.includes('SELECT * FROM journal_entries WHERE id=$1 AND company_id=$2 FOR UPDATE')||sql.includes('SELECT *,accounting_date::text FROM journal_entries WHERE id=$1 AND company_id=$2 FOR UPDATE')){
   const found=this.journal?.id===values[0]&&this.journal.company_id===values[1];return{rows:found?[this.journal]:[],rowCount:found?1:0};
  }
  if(sql.includes('COUNT(*)::text count')&&sql.includes('FROM accounts'))return{rows:[{count:String((values[1] as string[]).length)}],rowCount:1};
  if(sql.includes('SELECT * FROM journal_lines'))return{rows:[...this.lines],rowCount:this.lines.length};
  if(sql.includes('DELETE FROM journal_lines')){this.lines=[];return{rows:[],rowCount:0}}
  if(sql.includes('INSERT INTO journal_lines')){this.lines.push({id:`line-${this.lines.length+1}`,company_id:String(values[0]),journal_entry_id:String(values[1]),account_id:String(values[2]),debit:String(values[3]),credit:String(values[4]),memo:values[5] as string|null,sequence:Number(values[6])});return{rows:[],rowCount:1}}
  if(sql.includes('COUNT(*)::text count')&&sql.includes('FROM journal_lines'))return{rows:[{count:String(this.lines.length),debit:'50.00',credit:'50.00',active:String(this.lines.length)}],rowCount:1};
  if(sql.includes('SELECT $1::numeric(18,2)=$2::numeric(18,2) matches'))return{rows:[{matches:values[0]===values[1]}],rowCount:1};
  if(sql.includes("UPDATE journal_entries SET status='posted'")){if(this.journal?.status!=='draft')return{rows:[],rowCount:0};this.journal={...this.journal,status:'posted',posted_at:new Date('2026-08-02T00:00:00Z')};return{rows:[this.journal],rowCount:1}}
  if(sql.includes('INSERT INTO audit_log'))return{rows:[{id:'audit'}],rowCount:1};
  if(sql.includes('LEFT JOIN (journal_lines')&&sql.includes("j.status='posted'"))return{rows:this.journal?.status==='posted'?[{account_id:debitAccount,code:'1000',name:'Cash',account_type:'asset',debit_movement:'50.00',credit_movement:'0.00',debit_balance:'50.00',credit_balance:'0.00'}]:[],rowCount:this.journal?.status==='posted'?1:0};
  throw new Error(`Unexpected SQL: ${sql}`);
 };
 asPool(){return this as unknown as Pool}
}

const input=(overrides:Record<string,unknown>={})=>({fiscalYearId:yearId,accountingDate:'2026-08-01',description:'Supplier obligation',reference:null,sourceType:'obligation',sourceId,entryType:'standard' as const,...overrides});

describe('operational source to accounting integration',()=>{
 it('enforces supported source, tenant, date, and duplicate source-journal contracts',async()=>{
  await expect(new AccountingService(new AccountingPool().asPool()).createJournal(company,'actor',input({sourceType:'unsupported'}))).rejects.toBeInstanceOf(AccountingValidationError);
  await expect(new AccountingService(new AccountingPool().asPool()).createJournal(otherCompany,'actor',input())).rejects.toBeInstanceOf(AccountingNotFoundError);
  await expect(new AccountingService(new AccountingPool().asPool()).createJournal(company,'actor',input({accountingDate:'2026-08-02'}))).rejects.toThrow('Accounting date must match the operational source');
  const pool=new AccountingPool(),service=new AccountingService(pool.asPool());
  await service.createJournal(company,'actor',input());
  await expect(service.createJournal(company,'actor',input())).rejects.toBeInstanceOf(AccountingConflictError);
 });

 it('flows from source through draft, lines, posting, source consumption, and reporting',async()=>{
  const pool=new AccountingPool(),service=new AccountingService(pool.asPool());
  expect((await service.listOperationalSources(company)).sources.map(source=>source.source_id)).toEqual([sourceId]);
  const journal=await service.createJournal(company,'actor',input());
  expect(journal).toMatchObject({id:journalId,company_id:company,status:'draft',source_type:'obligation',source_id:sourceId});
  await service.replaceLines(company,'actor',journal.id,[
   {accountId:debitAccount,debit:'50.00',credit:'0.00',memo:null,sequence:1},
   {accountId:creditAccount,debit:'0.00',credit:'50.00',memo:'Payable',sequence:2},
  ]);
  const posted=await service.post(company,'actor',journal.id);
  expect(posted).toMatchObject({id:journalId,status:'posted'});
  expect((await service.listOperationalSources(company)).sources).toEqual([]);
  const report=await service.trialBalance(company,yearId,undefined,undefined);
  expect(report.accounts).toEqual([expect.objectContaining({account_id:debitAccount,debit_movement:'50.00',debit_balance:'50.00'})]);
 });
});
