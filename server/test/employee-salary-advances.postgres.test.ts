import { randomUUID } from 'crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { startHarness } from './helpers/http-pg';

const describeDatabase=process.env['DATABASE_URL']?describe:describe.skip;
type Harness=Awaited<ReturnType<typeof startHarness>>;

describeDatabase('employee salary advances (PostgreSQL)',()=>{
 let h:Harness;let seq=0;
 beforeAll(async()=>{h=await startHarness();});afterAll(()=>h.close());
 async function setup(label:string){
  const owner=await h.user(`${label}-owner`),approver=await h.user(`${label}-approver`),noEmployee=await h.user(`${label}-no-employee`),noAdvance=await h.user(`${label}-no-advance`),noBank=await h.user(`${label}-no-bank`),bankViewer=await h.user(`${label}-bank-viewer`),company=await h.company(`${label}-${++seq}`,owner.id);
  await h.member(company,approver.id,['employee.view','employee_salary_advance.approve']);
  await h.member(company,noEmployee.id,['employee_salary_advance.view']);
  await h.member(company,noAdvance.id,['employee.view','bank.view']);
  await h.member(company,noBank.id,['employee.view','employee_salary_advance.view','employee_salary_advance.issue','employee_salary_advance.cancel','accounting.journal.create']);
  await h.member(company,bankViewer.id,['employee.view','employee_salary_advance.view','bank.view']);
  for(const u of [owner,approver,noEmployee,noAdvance,noBank,bankViewer])await u.client.login();
  const fy=await h.fiscalYear(company,'FY26','2026-01-01','2026-12-31');
  const employee=(await owner.client.req('POST','/employees',{employee_number:`EA${seq}`,display_name:'Advance Employee',employment_start:'2025-01-01',employment_end:null})).json;
  const rec=await h.account(company,`EA-${seq}-AR`,'asset','current_asset'),bankGl=await h.account(company,`EA-${seq}-BANK`,'asset','current_asset');
  await h.q("INSERT INTO employee_salary_advance_account_mappings(company_id,account_id,updated_by) VALUES($1,$2,$3)",[company,rec,owner.id]);
  const bank=(await h.q<{id:string}>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id",[company,owner.id]))[0]!.id;
  await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1",[bankGl]);
  await h.q("INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)",[company,bank,bankGl,owner.id]);
  async function tx(amount='-250.00',date='2026-03-10') {return(await h.q<{id:string}>(`INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id) VALUES($1,$2,$3,$4,'SAR','Salary advance','ea-${seq}-${randomUUID()}',$5,'strong','manual','other',$6) RETURNING id`,[company,bank,date,amount,randomUUID().replaceAll('-',''),owner.id]))[0]!.id;}
  async function draft(amount='250.00') {const r=await owner.client.req('POST','/employee-salary-advances',{employee_id:employee.id,amount,issue_date:'2026-03-10',description:'Approved employee advance'});expect(r.status,JSON.stringify(r.json)).toBe(201);return r.json.advance.id as string;}
  return{owner,approver,noEmployee,noAdvance,noBank,bankViewer,company,fy,employee,rec,bankGl,tx,draft};
 }
 it('posts exactly once and transitions to issued only after successful atomic journal posting',async()=>{
  const x=await setup('advance-post');const id=await x.draft();
  expect((await x.owner.client.req('POST',`/employee-salary-advances/${id}/approve`,{version:1})).status).toBe(403); // creator cannot approve
  const approved=await x.approver.client.req('POST',`/employee-salary-advances/${id}/approve`,{version:1});expect(approved.status,JSON.stringify(approved.json)).toBe(200);
  const bank=await x.tx();const queued=await x.owner.client.req('POST',`/employee-salary-advances/${id}/issue`,{version:2,bank_transaction_id:bank});expect(queued.status,JSON.stringify(queued.json)).toBe(201);
  const journalId=queued.json.journal.id as string;
  expect((await x.owner.client.req('POST',`/journals/${journalId}/post`,{})).status).toBe(200);
  const state=(await h.q<{status:string;journal_entry_id:string}>("SELECT status,journal_entry_id FROM employee_salary_advances WHERE id=$1",[id]))[0]!;expect(state.status).toBe('issued');expect(state.journal_entry_id).toBe(journalId);
  expect(await h.count("SELECT COUNT(*)::text n FROM journal_lines WHERE journal_entry_id=$1 AND ((account_id=$2 AND debit=250 AND credit=0) OR (account_id=$3 AND credit=250 AND debit=0))",[journalId,x.rec,x.bankGl])).toBe(2);
  expect((await x.owner.client.req('POST',`/journals/${journalId}/post`,{})).status).toBe(409);
  expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='employee_advance_funding' AND status='posted'",[x.company])).toBe(1);
 });
 it('rejects bank ownership conflicts and concurrent claims without duplicate allocation',async()=>{
  const x=await setup('advance-race'),id=await x.draft();
  await x.approver.client.req('POST',`/employee-salary-advances/${id}/approve`,{version:1});const bank=await x.tx();
  const other=await x.draft();await x.approver.client.req('POST',`/employee-salary-advances/${other}/approve`,{version:1});
  const attempts=await Promise.all([id,other].map(advance=>x.owner.client.req('POST',`/employee-salary-advances/${advance}/issue`,{version:2,bank_transaction_id:bank})));
  expect(attempts.map(r=>r.status).sort()).toEqual([201,409]);
  expect(await h.count('SELECT COUNT(*)::text n FROM bank_transaction_matches WHERE company_id=$1 AND bank_transaction_id=$2',[x.company,bank])).toBe(1);
 });
 it('serializes an advance claim against a concurrent custody match',async()=>{
  const x=await setup('advance-custody-race'),id=await x.draft();await x.approver.client.req('POST',`/employee-salary-advances/${id}/approve`,{version:1});const bank=await x.tx();
  const custody=(await h.q<{id:string}>("INSERT INTO custody_advances(company_id,holder_user_id,purpose,created_by_user_id) VALUES($1,$2,'Custody remains distinct',$2) RETURNING id",[x.company,x.owner.id]))[0]!.id;
  const results=await Promise.allSettled([
   x.owner.client.req('POST',`/employee-salary-advances/${id}/issue`,{version:2,bank_transaction_id:bank}),
   h.q("INSERT INTO bank_transaction_matches(company_id,bank_transaction_id,document_id,custody_id,match_type,matched_by_user_id) VALUES($1,$2,NULL,$3,'custody_funding',$4)",[x.company,bank,custody,x.owner.id]),
  ]);
  const claims=await h.q<{match_type:string}>('SELECT match_type FROM bank_transaction_matches WHERE company_id=$1 AND bank_transaction_id=$2',[x.company,bank]);
  expect(claims).toHaveLength(1);expect(['employee_advance_funding','custody_funding']).toContain(claims[0]!.match_type);
  expect(results[0]!.status).toBe('fulfilled');
  expect(results[1]!.status==='fulfilled').toBe(claims[0]!.match_type==='custody_funding');
  const response=(results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof x.owner.client.req>>>).value;
  expect(response.status===201).toBe(claims[0]!.match_type==='employee_advance_funding');
 });
 it('rejects a bank transaction already used by a document settlement or a manual journal',async()=>{
  const x=await setup('advance-other-owners'),documentAdvance=await x.draft(),documentBank=await x.tx();
  await x.approver.client.req('POST',`/employee-salary-advances/${documentAdvance}/approve`,{version:1});
  const doc=(await h.q<{id:string}>("INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount) VALUES($1,$2,'invoice.pdf','application/pdf',4,$3,$4,'approved','purchase','2026-03-10','250.00') RETURNING id",[x.company,x.owner.id,randomUUID(),'a'.repeat(64)]))[0]!.id;
  await h.q("INSERT INTO bank_transaction_matches(company_id,document_id,bank_transaction_id,matched_by_user_id,match_type) VALUES($1,$2,$3,$4,'document')",[x.company,doc,documentBank,x.owner.id]);
  await h.q("INSERT INTO document_settlements(company_id,document_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,250,$4)",[x.company,doc,documentBank,x.owner.id]);
  expect((await x.owner.client.req('POST',`/employee-salary-advances/${documentAdvance}/issue`,{version:2,bank_transaction_id:documentBank})).status).toBe(409);
  const manualAdvance=await x.draft(),manualBank=await x.tx();await x.approver.client.req('POST',`/employee-salary-advances/${manualAdvance}/approve`,{version:1});
  const journal=(await h.q<{id:string}>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,'2026-03-10','Bound manual draft',$3) RETURNING id",[x.company,x.fy,x.owner.id]))[0]!.id;
  await h.q("INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence,bank_transaction_id) VALUES($1,$2,$3,250,0,'manual bank claim',1,$4)",[x.company,journal,x.bankGl,manualBank]);
  expect((await x.owner.client.req('POST',`/employee-salary-advances/${manualAdvance}/issue`,{version:2,bank_transaction_id:manualBank})).status).toBe(409);
  expect(await h.count('SELECT COUNT(*)::text n FROM bank_transaction_matches WHERE employee_salary_advance_id IN($1,$2)',[documentAdvance,manualAdvance])).toBe(0);
 });
 it('rejects bank transactions allocated to employee cost payments',async()=>{
  const x=await setup('advance-cost-owner'),id=await x.draft(),bank=await x.tx();await x.approver.client.req('POST',`/employee-salary-advances/${id}/approve`,{version:1});
  const cost=await x.owner.client.req('POST','/employee-costs',{employee_id:x.employee.id,record:{category:'salary',nature:'earning',currency_code:'SAR',total_amount:'250.00',service_period_start:'2026-03-01',service_period_end:'2026-03-31',description:'March salary',allocations:[{fiscal_year_id:x.fy,allocation_month:'2026-03-01',amount:'250.00'}]}});
  expect(cost.status,JSON.stringify(cost.json)).toBe(201);expect((await x.owner.client.req('POST',`/employee-costs/${cost.json.record.id}/approve`,{version:1})).status).toBe(200);
  const allocation=(await h.q<{id:string}>('SELECT id FROM employee_cost_allocations WHERE cost_record_id=$1',[cost.json.record.id]))[0]!.id;
  const paid=await x.owner.client.req('POST',`/employee-costs/${cost.json.record.id}/payments`,{cost_allocation_id:allocation,bank_transaction_id:bank,amount:'250.00',beneficiary_type:'employee',counterparty_id:null});expect(paid.status,JSON.stringify(paid.json)).toBe(201);
  expect((await x.owner.client.req('POST',`/employee-salary-advances/${id}/issue`,{version:2,bank_transaction_id:bank})).status).toBe(409);
  expect(await h.count('SELECT COUNT(*)::text n FROM bank_transaction_matches WHERE employee_salary_advance_id=$1',[id])).toBe(0);
 });
 it('rolls back failed posting and rejects mutation of pending funding evidence',async()=>{
  const x=await setup('advance-rollback'),id=await x.draft();await x.approver.client.req('POST',`/employee-salary-advances/${id}/approve`,{version:1});const bank=await x.tx();
  const queued=await x.owner.client.req('POST',`/employee-salary-advances/${id}/issue`,{version:2,bank_transaction_id:bank});const journal=queued.json.journal.id as string;
  await h.q("UPDATE journal_lines SET account_id=$2 WHERE journal_entry_id=$1 AND memo='employee_advance_receivable'",[journal,x.bankGl]);
  expect((await x.owner.client.req('POST',`/journals/${journal}/post`,{})).status).toBe(400);
  expect((await h.q<{status:string}>('SELECT status FROM employee_salary_advances WHERE id=$1',[id]))[0]!.status).toBe('pending_posting');
  expect((await h.q<{status:string}>('SELECT status FROM journal_entries WHERE id=$1',[journal]))[0]!.status).toBe('draft');
  expect(await h.count("SELECT COUNT(*)::text n FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id WHERE j.company_id=$1 AND j.source_type='employee_advance_funding' AND j.status='posted'",[x.company])).toBe(0);
  await expect(h.q('DELETE FROM bank_transaction_matches WHERE bank_transaction_id=$1',[bank])).rejects.toThrow(/cannot be changed/);
 });
 it('requires employee visibility and masks bank details unless bank.view is granted',async()=>{
  const x=await setup('advance-data-access'),id=await x.draft();await x.approver.client.req('POST',`/employee-salary-advances/${id}/approve`,{version:1});const bank=await x.tx();
  const queued=await x.owner.client.req('POST',`/employee-salary-advances/${id}/issue`,{version:2,bank_transaction_id:bank});expect(queued.status).toBe(201);
  expect((await x.owner.client.req('POST',`/journals/${queued.json.journal.id}/post`,{})).status).toBe(200);
  expect((await x.noEmployee.client.req('GET','/employee-salary-advances')).status).toBe(403);
  expect((await x.noAdvance.client.req('GET','/employee-salary-advances')).status).toBe(403);
  const hidden=await x.noBank.client.req('GET','/employee-salary-advances');expect(hidden.status).toBe(200);
  expect(hidden.json.bank_transactions).toEqual([]);expect(hidden.json.mapping_configured).toBe(true);expect(hidden.json.mapping).toBeNull();expect(hidden.json.accounts).toEqual([]);expect(hidden.json.advances[0]).toMatchObject({employee_number:x.employee.employee_number,bank_transaction_id:null,bank_transaction_date:null,bank_reference:null,reconciliation_status:null,journal_reference:null});
  expect((await x.noBank.client.req('POST',`/employee-salary-advances/${id}/issue`,{version:5,bank_transaction_id:bank})).status).toBe(403);
  const visible=await x.bankViewer.client.req('GET','/employee-salary-advances');expect(visible.status).toBe(200);
  expect(visible.json.advances[0].bank_transaction_id).toBe(bank);expect(visible.json.bank_transactions).toEqual([]);
 });
 it('cancels only pending issuance, releases its bank claim atomically, and retains voided journal evidence',async()=>{
  const x=await setup('advance-cancel'),id=await x.draft(),bank=await x.tx();await x.approver.client.req('POST',`/employee-salary-advances/${id}/approve`,{version:1});
  const queued=await x.owner.client.req('POST',`/employee-salary-advances/${id}/issue`,{version:2,bank_transaction_id:bank}),journal=queued.json.journal.id as string;expect(queued.status).toBe(201);
  expect((await x.noBank.client.req('POST',`/employee-salary-advances/${id}/cancel-pending`,{version:3,reason:'Unauthorized cancellation attempt'})).status).toBe(403);
  const cancelled=await x.owner.client.req('POST',`/employee-salary-advances/${id}/cancel-pending`,{version:3,reason:'Selected an incorrect bank entry'});expect(cancelled.status,JSON.stringify(cancelled.json)).toBe(200);
  expect((await h.q<{status:string}>('SELECT status FROM employee_salary_advances WHERE id=$1',[id]))[0]!.status).toBe('approved');
  expect((await h.q<{status:string}>('SELECT reconciliation_status status FROM bank_transactions WHERE id=$1',[bank]))[0]!.status).toBe('unmatched');
  expect((await h.q<{status:string}>('SELECT status FROM journal_entries WHERE id=$1',[journal]))[0]!.status).toBe('voided');
  expect(await h.count('SELECT COUNT(*)::text n FROM bank_transaction_matches WHERE id=(SELECT bank_transaction_match_id FROM employee_salary_advances WHERE id=$1)',[id])).toBe(0);
  expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND entity_id=$2 AND action='employee_salary_advance.pending_cancel'",[x.company,id])).toBe(1);
  const retry=await x.owner.client.req('POST',`/employee-salary-advances/${id}/issue`,{version:4,bank_transaction_id:bank});expect(retry.status,JSON.stringify(retry.json)).toBe(201);
  expect((await x.owner.client.req('POST',`/journals/${retry.json.journal.id}/post`,{})).status).toBe(200);
  const forbidden=await x.owner.client.req('POST',`/employee-salary-advances/${id}/cancel-pending`,{version:6,reason:'Cannot cancel posted issuance'});expect(forbidden.status).toBe(409);
  expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='employee_advance_funding' AND status='voided'",[x.company])).toBe(1);
  expect((await h.q<{status:string}>('SELECT status FROM employee_salary_advances WHERE id=$1',[id]))[0]!.status).toBe('issued');
 });
 it('serializes cancellation against journal posting so only one terminal action succeeds',async()=>{
  const x=await setup('advance-cancel-post-race'),id=await x.draft();await x.approver.client.req('POST',`/employee-salary-advances/${id}/approve`,{version:1});const bank=await x.tx();
  const queued=await x.owner.client.req('POST',`/employee-salary-advances/${id}/issue`,{version:2,bank_transaction_id:bank}),journal=queued.json.journal.id as string;
  const [cancel,post]=await Promise.all([
   x.owner.client.req('POST',`/employee-salary-advances/${id}/cancel-pending`,{version:3,reason:'Concurrent cancellation test'}),
   x.owner.client.req('POST',`/journals/${journal}/post`,{}),
  ]);
  expect((cancel.status===200&&post.status===409)||(cancel.status===409&&post.status===200)).toBe(true);
  const state=(await h.q<{status:string;reconciliation_status:string;journal_status:string}>('SELECT a.status,t.reconciliation_status,j.status journal_status FROM employee_salary_advances a JOIN bank_transactions t ON t.id=$2 AND t.company_id=a.company_id JOIN journal_entries j ON j.id=$3 AND j.company_id=a.company_id WHERE a.id=$1',[id,bank,journal]))[0]!;
  expect(state).toMatchObject(cancel.status===200?{status:'approved',reconciliation_status:'unmatched',journal_status:'voided'}:{status:'issued',reconciliation_status:'matched',journal_status:'posted'});
 });
});
