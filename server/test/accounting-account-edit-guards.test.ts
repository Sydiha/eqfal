import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AccountingConflictError, AccountingNotFoundError, AccountingService, AccountingValidationError } from '../src/modules/accounting/accounting.router';

type Row=Record<string,unknown>;
const base:Row={id:'a1',company_id:'c1',code:'1000',name:'Bank',account_type:'asset',parent_account_id:null,is_active:true,statement_category:'unmapped',cash_role:'non_cash',cash_flow_category:'unmapped',is_used:false,has_children:false};
// Fake pool: dispatches on SQL text so the guard logic runs without a database.
function service(opts:{before?:Row|null;duplicate?:boolean;parent?:Row|null;cycle?:boolean}={}){
 const writes:Array<{sql:string;params:unknown[]}>=[];
 const client={query:vi.fn(async(sql:string,params:unknown[]=[])=>{
  if(/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))return{rows:[],rowCount:0};
  if(sql.includes('FOR UPDATE OF a'))return{rows:opts.before===null?[]:[opts.before??base],rowCount:1};
  if(sql.includes('code=$2 AND id<>$3'))return{rows:[],rowCount:opts.duplicate?1:0};
  if(sql.includes('WITH RECURSIVE'))return{rows:[],rowCount:opts.cycle?1:0};
  if(sql.startsWith('SELECT * FROM accounts WHERE id=$1'))return{rows:opts.parent===undefined?[{id:'p1',is_active:true}]:opts.parent?[opts.parent]:[],rowCount:1};
  if(sql.startsWith('UPDATE accounts')){writes.push({sql,params});return{rows:[{...base,...{code:params[2],name:params[3],account_type:params[4],parent_account_id:params[5],is_active:params[6]}}],rowCount:1};}
  if(sql.includes('INSERT INTO audit_log')||sql.toLowerCase().includes('audit'))return{rows:[{}],rowCount:1};
  return{rows:[{is_used:false,has_children:false}],rowCount:1};
 }),release:vi.fn()};
 const svc=new AccountingService({connect:async()=>client} as unknown as Pool);
 (svc as unknown as {audit:{logEvent:()=>Promise<void>}}).audit={logEvent:async()=>{}};
 return{svc,writes};
}
describe('account edit guards',()=>{
 it('allows name and status changes on a used account',async()=>{const{svc,writes}=service({before:{...base,is_used:true}});await svc.updateAccount('c1','u1','a1',{name:'Main bank',active:false});expect(writes).toHaveLength(1);expect(writes[0]!.params.slice(2,7)).toEqual(['1000','Main bank','asset',null,false]);});
 it('rejects code, type and parent changes on a used account',async()=>{for(const input of[{code:'1999'},{accountType:'liability' as const},{parentId:'11111111-1111-4111-8111-111111111111'}]){const{svc,writes}=service({before:{...base,is_used:true}});await expect(svc.updateAccount('c1','u1','a1',input)).rejects.toBeInstanceOf(AccountingConflictError);expect(writes).toHaveLength(0);}});
 it('treats re-sending an unchanged locked value as a no-op, not a conflict',async()=>{const{svc}=service({before:{...base,is_used:true}});await expect(svc.updateAccount('c1','u1','a1',{code:'1000',accountType:'asset',name:'X'})).resolves.toBeTruthy();});
 it('allows code and parent edits on an unused account',async()=>{const{svc,writes}=service();await svc.updateAccount('c1','u1','a1',{code:'1999',parentId:'p1'});expect(writes[0]!.params.slice(2,7)).toEqual(['1999','Bank','asset','p1',true]);});
 it('locks the type when the account has children or is mapped to statements',async()=>{for(const before of[{...base,has_children:true},{...base,statement_category:'current_asset'},{...base,cash_role:'cash'},{...base,cash_flow_category:'operating'}]){const{svc}=service({before});await expect(svc.updateAccount('c1','u1','a1',{accountType:'liability'})).rejects.toBeInstanceOf(AccountingConflictError);}});
 it('rejects duplicate codes, missing or inactive parents and hierarchy cycles',async()=>{await expect(service({duplicate:true}).svc.updateAccount('c1','u1','a1',{code:'2000'})).rejects.toBeInstanceOf(AccountingConflictError);await expect(service({parent:null}).svc.updateAccount('c1','u1','a1',{parentId:'p9'})).rejects.toBeInstanceOf(AccountingValidationError);await expect(service({parent:{id:'p1',is_active:false}}).svc.updateAccount('c1','u1','a1',{parentId:'p1'})).rejects.toBeInstanceOf(AccountingValidationError);await expect(service({cycle:true}).svc.updateAccount('c1','u1','a1',{parentId:'p1'})).rejects.toBeInstanceOf(AccountingValidationError);await expect(service().svc.updateAccount('c1','u1','a1',{parentId:'a1'})).rejects.toBeInstanceOf(AccountingValidationError);});
 it('is scoped to the active company (unknown id in this company is not found)',async()=>{await expect(service({before:null}).svc.updateAccount('other','u1','a1',{name:'X'})).rejects.toBeInstanceOf(AccountingNotFoundError);});
});
