import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { startHarness } from './helpers/http-pg';
const db=process.env.DATABASE_URL?describe:describe.skip;
const EXCEPTION_CAP='payroll.settlement.exception.approve';
db('payroll settlement SoD exceptions (PostgreSQL)',()=>{
 let h:Awaited<ReturnType<typeof startHarness>>;
 beforeAll(async()=>{h=await startHarness();});afterAll(()=>h.close());
 async function fixture(label:string,reviewerConflict=false){
  const owner=await h.user(`${label}-owner`),contributor=await h.user(`${label}-contributor`),approver=await h.user(`${label}-approver`),poster=await h.user(`${label}-poster`),settler=await h.user(`${label}-settler`),reviewer=await h.user(`${label}-reviewer`),other=await h.user(`${label}-other`);
  const company=await h.company(label,owner.id),foreign=await h.company(`${label}-foreign`,other.id);
  const settlementCaps=['payroll.view','payroll.settlement.view','payroll.settlement.create','bank.view'];
  await h.member(company,contributor.id,settlementCaps);await h.member(company,approver.id,settlementCaps);await h.member(company,poster.id,settlementCaps);await h.member(company,settler.id,settlementCaps);await h.member(company,reviewer.id,[...settlementCaps,EXCEPTION_CAP]);
  for(const user of [owner,contributor,approver,poster,settler,reviewer,other])await user.client.login();
  const fy=await h.fiscalYear(company,'FY26','2026-01-01','2026-12-31');
  const expense=await h.account(company,'E','expense','operating_expense'),liability=await h.account(company,'L','liability','current_liability'),cash=await h.account(company,'B','asset','current_asset');
  await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1",[cash]);
  const draft=(await h.q<{id:string}>("INSERT INTO payroll_drafts(company_id,period_month,created_by,status,approved_by,approved_at) VALUES($1,'2026-02-01',$2,'approved',$3,NOW()) RETURNING id",[company,contributor.id,approver.id]))[0]!.id;
  await h.q('INSERT INTO payroll_draft_contributors(company_id,draft_id,user_id) VALUES($1,$2,$3)',[company,draft,contributor.id]);
  if(reviewerConflict)await h.q('INSERT INTO payroll_draft_contributors(company_id,draft_id,user_id) VALUES($1,$2,$3)',[company,draft,reviewer.id]);
  const payrollJournal=await h.postedJournal(company,fy,'2026-02-01',poster.id,[[expense,'100','0'],[liability,'0','100']],{source_type:'payroll',source_id:draft,memo:'net_payroll_liability'});
  const line=(await h.q<{id:string}>('SELECT id FROM journal_lines WHERE journal_entry_id=$1 AND account_id=$2',[payrollJournal,liability]))[0]!.id;
  const bankAccount=(await h.q<{id:string}>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Bank','SAR',$2) RETURNING id",[company,owner.id]))[0]!.id;
  await h.q('INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,\'2026-01-01\',$4)',[company,bankAccount,cash,owner.id]);
  const bank=async()=> (await h.q<{id:string}>("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id) VALUES($1,$2,'2026-02-10',-100,'SAR','Payroll',$3,$4,'strong','manual','other',$5) RETURNING id",[company,bankAccount,randomUUID(),createHash('sha256').update(randomUUID()).digest('hex'),owner.id]))[0]!.id;
  const body=(bankId:string,amount='10',sodExceptionId?:string)=>({bank_transaction_id:bankId,liability_line_id:line,amount,idempotency_key:randomUUID(),...(sodExceptionId?{sod_exception_id:sodExceptionId}:{})});
  return {owner,contributor,approver,poster,settler,reviewer,other,company,foreign,fy,draft,line,bank,body};
 }
 it('allows a nonparticipant and blocks each persisted payroll participant without an exception',async()=>{
  const x=await fixture('sod-basic'),bank=await x.bank();
  expect((await x.settler.client.req('POST','/payroll/settlements',x.body(bank))).status).toBe(201);
  for(const participant of [x.contributor,x.approver,x.poster]){
   const response=await participant.client.req('POST','/payroll/settlements',x.body(await x.bank()));
   expect(response.status,JSON.stringify(response.json)).toBe(409);expect(response.json.code).toBe('PAYROLL_SETTLEMENT_SOD_REQUIRED');
  }
 });
 it.each([
  ['company_manager','company_manager'],
  ['finance_manager','finance_manager'],
 ] as const)('allows %s authority to settle its own payroll participant work without an exception',async(label,key)=>{
  const x=await fixture(`sod-${label}`);
  let role=(await h.q<{id:string}>('SELECT id FROM roles WHERE company_id=$1 AND authorization_policy_key=$2 LIMIT 1',[x.company,key]))[0];
  if(!role)role=(await h.q<{id:string}>("UPDATE roles r SET authorization_policy_key=$3 FROM memberships m WHERE m.role_id=r.id AND m.company_id=r.company_id AND m.company_id=$1 AND m.user_id=$2 RETURNING r.id",[x.company,x.contributor.id,key]))[0];
  expect(role).toBeTruthy();
  await h.q('UPDATE memberships SET role_id=$3 WHERE company_id=$1 AND user_id=$2',[x.company,x.contributor.id,role!.id]);
  for(const capability of ['payroll.view','payroll.settlement.view','payroll.settlement.create','bank.view'])await h.q('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[role!.id,capability]);
  const response=await x.contributor.client.req('POST','/payroll/settlements',x.body(await x.bank()));
  expect(response.status,JSON.stringify(response.json)).toBe(201);
  expect(response.json.allocation.sod_exception_id).toBeNull();
 });
 it('allows a global System Administrator participant to settle without an exception',async()=>{
  const x=await fixture('sod-system-admin');
  await h.q('UPDATE users SET is_system_admin=TRUE WHERE id=$1',[x.contributor.id]);
  const response=await x.contributor.client.req('POST','/payroll/settlements',x.body(await x.bank()));
  expect(response.status,JSON.stringify(response.json)).toBe(201);
  expect(response.json.allocation.sod_exception_id).toBeNull();
 });
 it('requires an independent explicit approver and permits exactly the approved actor, company, liability and one settlement',async()=>{
  const x=await fixture('sod-approved');
  for(const user of [x.contributor,x.poster]){
   const role=(await h.q<{role_id:string}>('SELECT role_id FROM memberships WHERE company_id=$1 AND user_id=$2',[x.company,user.id]))[0]!.role_id;
   await h.q('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2)',[role,EXCEPTION_CAP]);
  }
  const request=await x.contributor.client.req('POST','/payroll/settlements/sod-exceptions',{liability_line_id:x.line,reason:'Only one available settlement operator'});
  expect(request.status,JSON.stringify(request.json)).toBe(201);
  const self=await x.contributor.client.req('POST',`/payroll/settlements/sod-exceptions/${request.json.id}/decision`,{decision:'approve',reason:'I approve my own request'});
  expect(self.status).toBe(403);expect(self.json.code).toBe('PAYROLL_SETTLEMENT_SOD_EXCEPTION_CONFLICTED_APPROVER');
  const conflicted=await x.poster.client.req('POST',`/payroll/settlements/sod-exceptions/${request.json.id}/decision`,{decision:'approve',reason:'I posted this payroll'});
  expect(conflicted.status).toBe(403);expect(conflicted.json.code).toBe('PAYROLL_SETTLEMENT_SOD_EXCEPTION_CONFLICTED_APPROVER');
  const decision=await x.reviewer.client.req('POST',`/payroll/settlements/sod-exceptions/${request.json.id}/decision`,{decision:'approve',reason:'Independent review completed'});
  expect(decision.status,JSON.stringify(decision.json)).toBe(200);
  const bank=await x.bank();
  expect((await x.approver.client.req('POST','/payroll/settlements',x.body(bank,'10',request.json.id))).json.code).toBe('PAYROLL_SETTLEMENT_SOD_EXCEPTION_INVALID');
  const wrongLiability=x.body(bank,'10',request.json.id);wrongLiability.liability_line_id='00000000-0000-4000-8000-000000000001';
  expect((await x.contributor.client.req('POST','/payroll/settlements',wrongLiability)).status).toBe(409);
  const posted=await x.contributor.client.req('POST','/payroll/settlements',x.body(bank,'10',request.json.id));
  expect(posted.status,JSON.stringify(posted.json)).toBe(201);
  expect(posted.json.allocation.sod_exception_id).toBe(request.json.id);
  expect((await x.contributor.client.req('POST','/payroll/settlements',x.body(await x.bank(),'10',request.json.id))).status).toBe(409);
  const row=(await h.q<{status:string;settlement_id:string;decided_by:string;requester:string;reason:string}>('SELECT status,settlement_id,decided_by,requested_by requester,decision_reason reason FROM payroll_settlement_sod_exceptions WHERE id=$1',[request.json.id]))[0]!;
  expect(row).toMatchObject({status:'consumed',settlement_id:posted.json.allocation.id,decided_by:x.reviewer.id,requester:x.contributor.id,reason:'Independent review completed'});
 });
 it('invalidates approval when the persisted SoD participants change before settlement',async()=>{
  const x=await fixture('sod-stale');
  const request=await x.contributor.client.req('POST','/payroll/settlements/sod-exceptions',{liability_line_id:x.line,reason:'Small company staffing exception'});
  expect(request.status).toBe(201);
  expect((await x.reviewer.client.req('POST',`/payroll/settlements/sod-exceptions/${request.json.id}/decision`,{decision:'approve',reason:'Independent review completed'})).status).toBe(200);
  await h.q('INSERT INTO payroll_draft_contributors(company_id,draft_id,user_id) VALUES($1,$2,$3)',[x.company,x.draft,x.other.id]);
  expect((await x.contributor.client.req('POST','/payroll/settlements',x.body(await x.bank(),'10',request.json.id))).json.code).toBe('PAYROLL_SETTLEMENT_SOD_EXCEPTION_STALE');
  const refreshed=await x.contributor.client.req('POST','/payroll/settlements/sod-exceptions',{liability_line_id:x.line,reason:'Participant evidence changed'});
  expect(refreshed.status).toBe(201);expect(refreshed.json.status).toBe('pending');expect(refreshed.json.id).not.toBe(request.json.id);
 });
 it('fails closed for missing evidence, conflicted approvers, cross-company requests and administrators without explicit authority',async()=>{
  const x=await fixture('sod-evidence');
  await h.q('DELETE FROM payroll_draft_contributors WHERE company_id=$1 AND draft_id=$2',[x.company,x.draft]);
  const bank=await x.bank();
  expect((await x.settler.client.req('POST','/payroll/settlements',x.body(bank))).json.code).toBe('PAYROLL_SETTLEMENT_SOD_EVIDENCE_INVALID');
  const y=await fixture('sod-reviewer-conflict',true);
  const request=await y.contributor.client.req('POST','/payroll/settlements/sod-exceptions',{liability_line_id:y.line,reason:'Limited staffing requires a review'});
  expect(request.status).toBe(201);
  expect((await y.reviewer.client.req('POST',`/payroll/settlements/sod-exceptions/${request.json.id}/decision`,{decision:'approve',reason:'I am also a payroll contributor'})).json.code).toBe('PAYROLL_SETTLEMENT_SOD_EXCEPTION_CONFLICTED_APPROVER');
  const foreignReviewer=await h.user('sod-foreign-reviewer');await h.member(y.foreign,foreignReviewer.id,['payroll.view',EXCEPTION_CAP]);await foreignReviewer.client.login();
  const foreignDecision=await foreignReviewer.client.req('POST',`/payroll/settlements/sod-exceptions/${request.json.id}/decision`,{decision:'approve',reason:'Do not reuse another company request'});
  expect(foreignDecision.status).toBe(404);
  expect((await y.owner.client.req('POST',`/payroll/settlements/sod-exceptions/${request.json.id}/decision`,{decision:'approve',reason:'Full Access is not independent approval'})).status).toBe(403);
  const systemAdmin=await h.user('sod-global-admin');
  await h.q('UPDATE users SET is_system_admin=TRUE,system_admin_policy_version=1 WHERE id=$1',[systemAdmin.id]);await systemAdmin.client.login();
  expect((await systemAdmin.client.req('POST',`/payroll/settlements/sod-exceptions/${request.json.id}/decision`,{decision:'approve',reason:'Global authority alone is not approval'})).status).toBe(403);
 });
});
import { createHash, randomUUID } from 'node:crypto';
