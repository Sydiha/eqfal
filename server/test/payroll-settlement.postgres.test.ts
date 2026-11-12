import { randomUUID } from 'crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { startHarness } from './helpers/http-pg';
import { UNRESOLVED_BANK_TRANSACTION_SQL } from '../src/modules/banking/bank-reconciliation-core';
const db=process.env.DATABASE_URL?describe:describe.skip;
db('payroll settlement API (PostgreSQL)',()=>{
 let h:Awaited<ReturnType<typeof startHarness>>;
 beforeAll(async()=>{h=await startHarness();});afterAll(()=>h.close());
 async function fixture(label:string){
  const owner=await h.user(label+'owner'),actor=await h.user(label+'actor'),other=await h.user(label+'other');
  const co=await h.company(label,owner.id),foreign=await h.company(label+'foreign',other.id);
  await h.member(co,actor.id,['payroll.view','payroll.settlement.view','payroll.settlement.create','bank.view','bank.reconcile']);
  for(const u of [owner,actor,other])await u.client.login();
  const fy=await h.fiscalYear(co,'FY26','2026-01-01','2026-12-31');
  const expense=await h.account(co,'E','expense','operating_expense'),liability=await h.account(co,'L','liability','current_liability'),cash=await h.account(co,'B','asset','current_asset');
  await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1",[cash]);
  const draft=(await h.q<{id:string}>("INSERT INTO payroll_drafts(company_id,period_month,created_by,status,approved_by,approved_at) VALUES($1,'2026-02-01',$2,'approved',$2,NOW()) RETURNING id",[co,owner.id]))[0]!.id;
  const original=await h.postedJournal(co,fy,'2026-02-01',owner.id,[[expense,'100','0'],[liability,'0','100']],{source_type:'payroll',source_id:draft,memo:'net_payroll_liability'});
  const line=(await h.q<{id:string}>('SELECT id FROM journal_lines WHERE journal_entry_id=$1 AND account_id=$2',[original,liability]))[0]!.id;
  const bank=(await h.q<{id:string}>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Bank','SAR',$2) RETURNING id",[co,owner.id]))[0]!.id;
  await h.q("INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)",[co,bank,cash,owner.id]);
  async function tx(amount='-100'){return (await h.q<{id:string}>("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id) VALUES($1,$2,'2026-02-10',$3,'SAR','Payroll',$4,$5,'strong','manual','other',$6) RETURNING id",[co,bank,amount,randomUUID(),randomUUID().replaceAll('-',''),owner.id]))[0]!.id;}
  const body=(bank_transaction_id:string,amount:string,key=randomUUID())=>({bank_transaction_id,liability_line_id:line,amount,idempotency_key:key});
  return {owner,actor,other,co,foreign,fy,line,original,liability,cash,tx,body};
 }
 it('posts partial and full settlement once with exact liability and bank lines',async()=>{
  const x=await fixture('api-post'),bank=await x.tx(),input=x.body(bank,'40');
  const a=await x.actor.client.req('POST','/payroll/settlements',input);expect(a.status,JSON.stringify(a.json)).toBe(201);
  expect((await h.q<{unresolved:boolean}>(`SELECT ${UNRESOLVED_BANK_TRANSACTION_SQL} unresolved FROM bank_transactions t WHERE t.id=$1`,[bank]))[0]!.unresolved).toBe(true);
  const candidates=await x.actor.client.req('GET',`/bank-transactions/${bank}/match-candidates`);
  expect(candidates.json).toMatchObject({allocated_amount:'40.00',unallocated_amount:'60.00',documents:[]});
  expect((await x.actor.client.req('POST',`/bank-transactions/${bank}/reconciliation`,{status:'reconciled'})).status).toBe(409);
  const banks=await x.actor.client.req('GET','/payroll/settlements/bank-transactions');expect(banks.json.bank_transactions.find((t:{id:string})=>t.id===bank).remaining_amount).toBe('60.00');
  expect((await x.actor.client.req('POST','/payroll/settlements',input)).status).toBe(200);
  expect((await x.actor.client.req('POST','/payroll/settlements',{...input,amount:'41'})).status).toBe(409);
  const b=await x.actor.client.req('POST','/payroll/settlements',x.body(bank,'60'));expect(b.status,JSON.stringify(b.json)).toBe(201);
  expect((await h.q<{unresolved:boolean}>(`SELECT ${UNRESOLVED_BANK_TRANSACTION_SQL} unresolved FROM bank_transactions t WHERE t.id=$1`,[bank]))[0]!.unresolved).toBe(false);
  const withoutPayroll=await h.user('bank-only');await h.member(x.co,withoutPayroll.id,['bank.view','bank.reconcile']);await withoutPayroll.client.login();
  expect((await withoutPayroll.client.req('GET',`/bank-transactions/${bank}/match-candidates`)).status).toBe(403);
  expect((await withoutPayroll.client.req('POST',`/bank-transactions/${bank}/reconciliation`,{status:'reconciled'})).status).toBe(403);
  expect((await x.actor.client.req('POST',`/bank-transactions/${bank}/reconciliation`,{status:'reconciled'})).status).toBe(200);
  expect((await x.actor.client.req('POST',`/bank-transactions/${bank}/reconciliation`,{status:'reconciled'})).status).toBe(409);
  expect((await x.actor.client.req('POST','/payroll/settlements',x.body(bank,'1'))).status).toBe(409);
  const rows=await h.q<{account_id:string;debit:string;credit:string}>('SELECT account_id,debit::text,credit::text FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence',[a.json.allocation.journal_entry_id]);
  expect(rows).toEqual([{account_id:x.liability,debit:'40.00',credit:'0.00'},{account_id:x.cash,debit:'0.00',credit:'40.00'}]);
  const liabs=await x.actor.client.req('GET','/payroll/settlements/liabilities');expect(liabs.json.liabilities[0].remaining_amount).toBe('0.00');
  expect(await h.count("SELECT count(*)::text n FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.company_id=$1 AND j.status='posted' AND l.account_id=$2",[x.co,x.liability])).toBe(3);
  expect(await h.count("SELECT count(*)::text n FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id JOIN accounts a ON a.id=l.account_id WHERE j.company_id=$1 AND j.status='posted' AND a.account_type='expense'",[x.co])).toBe(1);
  expect(await h.count("SELECT count(*)::text n FROM audit_log WHERE company_id=$1 AND action='payroll.settlement.create'",[x.co])).toBe(2);
 });
 it('enforces capabilities, tenant isolation and closed periods',async()=>{
  const x=await fixture('api-auth'),bank=await x.tx();
  expect((await x.owner.client.req('POST','/payroll/settlements',x.body(bank,'10'))).status).toBe(403);
  expect((await x.other.client.req('POST','/payroll/settlements',x.body(bank,'10'))).status).toBe(403);
  const foreignActor=await h.user('foreign-settler');await h.member(x.foreign,foreignActor.id,['payroll.view','payroll.settlement.view','payroll.settlement.create']);await foreignActor.client.login();
  expect((await foreignActor.client.req('POST','/payroll/settlements',x.body(bank,'10'))).status).toBe(404);
  await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1",[x.fy]);
  expect((await x.actor.client.req('POST','/payroll/settlements',x.body(bank,'10'))).status).toBe(409);
  expect(await h.count('SELECT count(*)::text n FROM payroll_settlement_allocations WHERE company_id=$1',[x.co])).toBe(0);
 });
 it('serializes concurrent claims and rejects a bank already claimed by another workflow',async()=>{
  const x=await fixture('api-race'),a=await x.tx(),b=await x.tx();
  const requests=await Promise.all([a,b].map(t=>x.actor.client.req('POST','/payroll/settlements',x.body(t,'70'))));
  expect(requests.map(r=>r.status).sort()).toEqual([201,409]);
  const matched=await x.tx();
  const doc=(await h.q<{id:string}>("INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount) VALUES($1,$2,'i.pdf','application/pdf',4,$3,$4,'approved','purchase','2026-02-01',100) RETURNING id",[x.co,x.owner.id,randomUUID(),'a'.repeat(64)]))[0]!.id;
  await h.q("INSERT INTO bank_transaction_matches(company_id,document_id,bank_transaction_id,matched_by_user_id,match_type) VALUES($1,$2,$3,$4,'document')",[x.co,doc,matched,x.owner.id]);
  const settlement=(await h.q<{id:string}>("INSERT INTO document_settlements(company_id,document_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,100,$4) RETURNING id",[x.co,doc,matched,x.owner.id]))[0]!.id;
  await h.postedJournal(x.co,x.fy,'2026-02-10',x.owner.id,[[x.liability,'100','0'],[x.cash,'0','100']],{source_type:'document_settlement',source_id:settlement});
  expect((await x.actor.client.req('POST','/payroll/settlements',x.body(matched,'10'))).status).toBe(409);
  expect(await h.count("SELECT count(*)::text n FROM journal_entries j JOIN document_settlements s ON s.id=j.source_id AND s.company_id=j.company_id WHERE s.bank_transaction_id=$1 AND j.status='posted'",[matched])).toBe(1);
 });
 it('rejects an unlinked bank account',async()=>{
  const x=await fixture('api-unlinked');
  const bank=(await h.q<{id:string}>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Unlinked','SAR',$2) RETURNING id",[x.co,x.owner.id]))[0]!.id;
  const t=(await h.q<{id:string}>("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id) VALUES($1,$2,'2026-02-10',-20,'SAR','Payroll',$3,$4,'strong','manual','other',$5) RETURNING id",[x.co,bank,randomUUID(),randomUUID().replaceAll('-',''),x.owner.id]))[0]!.id;
  expect((await x.actor.client.req('POST','/payroll/settlements',x.body(t,'10'))).status).toBe(409);
 });
 it('serializes a payroll claim against a concurrent document match',async()=>{
  const x=await fixture('api-cross-race'),bank=await x.tx();
  const doc=(await h.q<{id:string}>("INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount) VALUES($1,$2,'i.pdf','application/pdf',4,$3,$4,'approved','purchase','2026-02-01',100) RETURNING id",[x.co,x.owner.id,randomUUID(),'a'.repeat(64)]))[0]!.id;
  const [payment,match]=await Promise.all([x.actor.client.req('POST','/payroll/settlements',x.body(bank,'100')),h.q("INSERT INTO bank_transaction_matches(company_id,document_id,bank_transaction_id,matched_by_user_id,match_type) VALUES($1,$2,$3,$4,'document')",[x.co,doc,bank,x.owner.id]).then(()=>true,()=>false)]);
  expect([payment.status===201,match].filter(Boolean)).toHaveLength(1);
  expect([201,409]).toContain(payment.status);
 });
 it('rolls back the allocation and journal if audit recording fails',async()=>{
  const x=await fixture('api-rollback'),bank=await x.tx();
  await h.q("CREATE FUNCTION payroll_settlement_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payroll.settlement.create' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$");
  await h.q('CREATE TRIGGER payroll_settlement_test_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION payroll_settlement_test_audit_failure()');
  try {expect((await x.actor.client.req('POST','/payroll/settlements',x.body(bank,'10'))).status).toBe(500);}
  finally {await h.q('DROP TRIGGER payroll_settlement_test_audit_failure ON audit_log');await h.q('DROP FUNCTION payroll_settlement_test_audit_failure()');}
  expect(await h.count('SELECT count(*)::text n FROM payroll_settlement_allocations WHERE company_id=$1',[x.co])).toBe(0);
  expect(await h.count("SELECT count(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='payroll_settlement'",[x.co])).toBe(0);
 });
});
