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
  async function manualJournal(bankTransactionId:string|null){
   const created=await owner.client.req('POST','/journals',{fiscal_year_id:fy,accounting_date:'2026-02-10',description:'Manual bank payment',reference:null,entry_type:'standard'});
   expect(created.status,JSON.stringify(created.json)).toBe(201);
   const saved=await owner.client.req('PUT',`/journals/${created.json.id}/lines`,{lines:[
    {account_id:liability,bank_transaction_id:null,debit:'100',credit:'0',memo:null},
    {account_id:cash,bank_transaction_id:bankTransactionId,debit:'0',credit:'100',memo:null},
   ]},{'if-match':'1'});
   expect(saved.status,JSON.stringify(saved.json)).toBe(200);
   return created.json.id as string;
  }
  return {owner,actor,other,co,foreign,fy,line,original,liability,cash,tx,body,manualJournal};
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
  const history=await x.actor.client.req('GET','/payroll/settlements');
  expect(history.status).toBe(200);expect(history.json.settlements).toHaveLength(2);
  expect(history.json.settlements[0]).toMatchObject({bank_transaction_id:bank,reconciliation_status:'reconciled',bank_allocated_amount:'100.00',bank_amount:'-100.00'});
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
  const noBank=await h.user('settler-without-bank');await h.member(x.co,noBank.id,['payroll.view','payroll.settlement.view','payroll.settlement.create']);await noBank.client.login();
  expect((await noBank.client.req('GET','/payroll/settlements/bank-transactions')).status).toBe(403);
  expect((await noBank.client.req('GET','/payroll/settlements')).status).toBe(403);
  expect((await noBank.client.req('POST','/payroll/settlements',x.body(bank,'10'))).status).toBe(403);
  expect((await x.other.client.req('POST','/payroll/settlements',x.body(bank,'10'))).status).toBe(403);
  const foreignActor=await h.user('foreign-settler');await h.member(x.foreign,foreignActor.id,['payroll.view','payroll.settlement.view','payroll.settlement.create','bank.view']);await foreignActor.client.login();
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
 it('allows an unbound source-less bank credit and quarantines its account from payroll settlement',async()=>{
  const x=await fixture('api-manual-bank-credit'),bank=await x.tx('-100');
  const journal=await x.manualJournal(null);
  expect((await x.owner.client.req('POST',`/journals/${journal}/post`,{})).status).toBe(200);
  expect((await h.q<{status:string}>('SELECT status FROM journal_entries WHERE id=$1',[journal]))[0]!.status).toBe('posted');
  expect((await x.actor.client.req('POST','/payroll/settlements',x.body(bank,'100'))).json.code).toBe('PAYROLL_SETTLEMENT_BANK_ACCOUNT_QUARANTINED');
  expect(await h.count('SELECT count(*)::text n FROM payroll_settlement_allocations WHERE company_id=$1',[x.co])).toBe(0);
  const draft=(await h.q<{id:string}>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,'2026-02-10','Direct guard probe',$3) RETURNING id",[x.co,x.fy,x.owner.id]))[0]!.id;
  await expect(h.q("INSERT INTO payroll_settlement_allocations(company_id,bank_transaction_id,liability_line_id,journal_entry_id,amount,idempotency_key,created_by) VALUES($1,$2,$3,$4,10,$5,$6)",[x.co,bank,x.line,draft,randomUUID(),x.actor.id])).rejects.toThrow(/unresolved manual journal uncertainty/);
 });
 it('quarantines only the affected account and requires authorized evidence review of every unresolved posting',async()=>{
  const x=await fixture('api-manual-account-quarantine'),bank=await x.tx('-100');
  const journalA=await x.manualJournal(null),journalB=await x.manualJournal(null);
  expect((await x.owner.client.req('POST',`/journals/${journalA}/post`,{})).status).toBe(200);
  expect((await x.owner.client.req('POST',`/journals/${journalB}/post`,{})).status).toBe(200);
  const otherBank=(await h.q<{id:string}>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Other bank','SAR',$2) RETURNING id",[x.co,x.owner.id]))[0]!.id;
  const otherCash=await h.account(x.co,'B2','asset','current_asset');await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1",[otherCash]);
  await h.q("INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)",[x.co,otherBank,otherCash,x.owner.id]);
  const otherTx=(await h.q<{id:string}>("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id) VALUES($1,$2,'2026-02-10',-20,'SAR','Other payment',$3,$4,'strong','manual','other',$5) RETURNING id",[x.co,otherBank,randomUUID(),randomUUID().replaceAll('-',''),x.owner.id]))[0]!.id;
  const candidates=await x.actor.client.req('GET','/payroll/settlements/bank-transactions');
  expect(candidates.json.bank_transactions.some((t:{id:string})=>t.id===bank)).toBe(false);
  expect(candidates.json.bank_transactions.some((t:{id:string})=>t.id===otherTx)).toBe(true);
  const affectedBankAccount=(await h.q<{id:string}>("SELECT bank_account_id id FROM bank_transactions WHERE company_id=$1 AND id=$2",[x.co,bank]))[0]!.id;
  const lineA=(await h.q<{id:string}>("SELECT id FROM journal_lines WHERE journal_entry_id=$1 AND account_id=$2",[journalA,x.cash]))[0]!.id;
  expect((await x.actor.client.req('POST',`/accounting/bank-journal-uncertainties/${lineA}/clear`,{bank_account_id:affectedBankAccount,evidence_reference:'statement:review-1',rationale:'Verified unrelated adjustment evidence'})).status).toBe(403);
  expect((await x.actor.client.req('POST','/payroll/settlements',x.body(otherTx,'10'))).status).toBe(201);
  const reviewer=await h.user('quarantine-reviewer');
  await h.member(x.co,reviewer.id,['accounting.view','accounting.journal.post']);await reviewer.client.login();
  const uncertainties=await reviewer.client.req('GET','/accounting/bank-journal-uncertainties');
  const affected=uncertainties.json.uncertainties.filter((u:{bank_account_id:string})=>u.bank_account_id===affectedBankAccount);
  expect(affected).toHaveLength(2);
  const first=affected[0]!,second=affected[1]!;
  const clear1=await reviewer.client.req('POST',`/accounting/bank-journal-uncertainties/${first.journal_line_id}/clear`,{bank_account_id:first.bank_account_id,evidence_reference:'statement:review-1',rationale:'Verified this adjustment is unrelated to a bank payment'});
  expect(clear1.status,JSON.stringify(clear1.json)).toBe(201);expect(clear1.json).toMatchObject({quarantined:true,unresolved_count:1});
  expect((await x.actor.client.req('POST','/payroll/settlements',x.body(bank,'10'))).status).toBe(409);
  expect((await reviewer.client.req('POST',`/accounting/bank-journal-uncertainties/${second.journal_line_id}/clear`,{bank_account_id:second.bank_account_id,evidence_reference:'statement:review-2',rationale:'Verified this second adjustment is unrelated'})).json).toMatchObject({quarantined:false,unresolved_count:0});
  expect((await x.actor.client.req('POST','/payroll/settlements',x.body(bank,'10'))).status).toBe(201);
  expect(await h.count("SELECT count(*)::text n FROM audit_log WHERE company_id=$1 AND action='accounting.manual_bank_uncertainty.clear'",[x.co])).toBe(2);
  await expect(h.q("UPDATE manual_bank_journal_uncertainty_reviews SET rationale='edited' WHERE company_id=$1",[x.co])).rejects.toThrow(/immutable/);
 });
 it('binds a manual bank journal deterministically and blocks payroll reuse',async()=>{
  const x=await fixture('api-manual-bank-binding'),bank=await x.tx('-100'),journal=await x.manualJournal(bank);
  expect((await x.owner.client.req('POST',`/journals/${journal}/post`,{})).status).toBe(200);
  expect((await x.actor.client.req('POST','/payroll/settlements',x.body(bank,'100'))).status).toBe(409);
  expect(await h.count("SELECT count(*)::text n FROM bank_transaction_accounting_claims WHERE company_id=$1 AND bank_transaction_id=$2 AND owner_type='manual_journal_line'",[x.co,bank])).toBe(1);
  expect(await h.count('SELECT count(*)::text n FROM bank_transaction_journal_evidence WHERE company_id=$1 AND journal_entry_id=$2',[x.co,journal])).toBe(1);
 });
 it('preserves unrelated manual journals and audited reversal of a bound bank journal',async()=>{
  const x=await fixture('api-manual-preserve'),bank=await x.tx('-100'),journal=await x.manualJournal(bank);
  expect((await x.owner.client.req('POST',`/journals/${journal}/post`,{})).status).toBe(200);
  const reversed=await x.owner.client.req('POST',`/journals/${journal}/reverse`,{accounting_date:'2026-02-11',reason:'Correct the manual bank posting'});
  expect(reversed.status,JSON.stringify(reversed.json)).toBe(201);
  expect(await h.count('SELECT count(*)::text n FROM journal_lines WHERE journal_entry_id=$1 AND bank_transaction_id IS NOT NULL',[reversed.json.reversal.id])).toBe(0);
  const unrelated=await x.owner.client.req('POST','/journals',{fiscal_year_id:x.fy,accounting_date:'2026-02-12',description:'Non-bank adjustment',reference:null,entry_type:'standard'});
  const other=await h.account(x.co,'OTHER','expense','operating_expense');
  expect((await x.owner.client.req('PUT',`/journals/${unrelated.json.id}/lines`,{lines:[{account_id:x.liability,debit:'1',credit:'0',memo:null},{account_id:other,debit:'0',credit:'1',memo:null}]},{'if-match':'1'})).status).toBe(200);
  expect((await x.owner.client.req('POST',`/journals/${unrelated.json.id}/post`,{})).status).toBe(200);
 });
 it('serializes a bound manual bank posting against payroll settlement',async()=>{
  const x=await fixture('api-manual-payroll-race'),bank=await x.tx('-100'),journal=await x.manualJournal(bank);
  const [manual,payroll]=await Promise.all([
   x.owner.client.req('POST',`/journals/${journal}/post`,{}),
   x.actor.client.req('POST','/payroll/settlements',x.body(bank,'100')),
  ]);
  expect([manual.status===200,payroll.status===201].filter(Boolean)).toHaveLength(1);
  expect([manual.status,manual.json,payroll.status,payroll.json],JSON.stringify({manual:manual.json,payroll:payroll.json})).toEqual(expect.arrayContaining([expect.anything()]));
  expect([manual.status,409],JSON.stringify({manual:manual.json,payroll:payroll.json})).toContain(manual.status);expect([201,409],JSON.stringify({manual:manual.json,payroll:payroll.json})).toContain(payroll.status);
  const effects=await h.count(`SELECT count(*)::text n FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
    WHERE l.company_id=$1 AND l.account_id=$2 AND l.credit=100 AND j.status='posted'`,[x.co,x.cash]);
  expect(effects).toBe(1);
 });
 it('fails closed for bank transactions predating deterministic manual binding',async()=>{
  const x=await fixture('api-prebinding-bank');
  await x.tx('-1');
  const bank=(await h.q<{id:string}>("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id,manual_journal_binding_protected) SELECT company_id,bank_account_id,'2026-02-10',-100,'SAR','Historical',$2,$3,'strong','manual','other',$4,FALSE FROM bank_transactions WHERE company_id=$1 LIMIT 1 RETURNING id",[x.co,randomUUID(),randomUUID().replaceAll('-',''),x.owner.id]))[0]!.id;
  const listed=await x.actor.client.req('GET','/payroll/settlements/bank-transactions');
  expect(listed.json.bank_transactions.some((t:{id:string})=>t.id===bank)).toBe(false);
  expect((await x.actor.client.req('POST','/payroll/settlements',x.body(bank,'100'))).status).toBe(409);
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
 it('settles all liability categories across posted payroll runs using their original accounts',async()=>{
  const x=await fixture('api-categories'),bank=await x.tx('-130');
  const deduction=await h.account(x.co,'D','liability','current_liability'),contribution=await h.account(x.co,'C','liability','current_liability');
  const expense=await h.account(x.co,'E2','expense','operating_expense');
  const draft=(await h.q<{id:string}>("INSERT INTO payroll_drafts(company_id,period_month,created_by,status,approved_by,approved_at) VALUES($1,'2026-01-01',$2,'approved',$2,NOW()) RETURNING id",[x.co,x.owner.id]))[0]!.id;
  const journal=(await h.q<{id:string}>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,source_type,source_id,created_by) VALUES($1,$2,'2026-01-01','Payroll','payroll',$3,$4) RETURNING id",[x.co,x.fy,draft,x.owner.id]))[0]!.id;
  await h.q("INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,30,0,'earnings_expense',1),($1,$2,$4,0,10,'employee_deduction_liability',2),($1,$2,$5,0,20,'employer_contribution_liability',3)",[x.co,journal,expense,deduction,contribution]);
  await h.q("UPDATE journal_entries SET status='posted',posted_by=$2,posted_at=NOW() WHERE id=$1",[journal,x.owner.id]);
  const lines=await h.q<{id:string;memo:string;account_id:string}>("SELECT id,memo,account_id FROM journal_lines WHERE journal_entry_id=$1 AND credit>0 ORDER BY sequence",[journal]);
  for(const [line,amount] of [[x.line,'100'],[lines[0]!.id,'10'],[lines[1]!.id,'20']]){
   const result=await x.actor.client.req('POST','/payroll/settlements',{...x.body(bank!,amount!),liability_line_id:line});
   expect(result.status,JSON.stringify(result.json)).toBe(201);
  }
  const status=await x.actor.client.req('GET','/payroll/settlements/liabilities');
  expect(status.json.liabilities).toHaveLength(3);expect(status.json.liabilities.every((l:{remaining_amount:string})=>l.remaining_amount==='0.00')).toBe(true);
  expect(await h.count("SELECT count(*)::text n FROM payroll_settlement_allocations p JOIN journal_lines original ON original.id=p.liability_line_id JOIN journal_lines settled ON settled.journal_entry_id=p.journal_entry_id AND settled.account_id=original.account_id AND settled.debit=p.amount WHERE p.company_id=$1",[x.co])).toBe(3);
 });
});
