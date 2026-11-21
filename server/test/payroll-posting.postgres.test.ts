import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

const db = process.env['DATABASE_URL'] ? describe : describe.skip;
const keys = ['earnings_expense','employer_contribution_expense','net_payroll_liability','employee_deduction_liability','employer_contribution_liability'];
const values = {version:0,salary:'100.10',housing_allowance:'0.10',transportation_allowance:'0.05',other_allowance:'0.05',bonus:'0.30',overtime:'0.40',deductions:'0.50',employer_contributions:'0.60'};

db('payroll posting (PostgreSQL)',()=>{
 let h:Awaited<ReturnType<typeof startHarness>>;
 beforeAll(async()=>{h=await startHarness();}); afterAll(()=>h.close());
 async function fixture(label:string, approve=true) {
  const owner=await h.user(`${label}-owner`), editor=await h.user(`${label}-editor`), approver=await h.user(`${label}-approver`), poster=await h.user(`${label}-poster`), outsider=await h.user(`${label}-outsider`);
  const co=await h.company(label,owner.id), other=await h.company(`${label}-other`,outsider.id);
  await h.member(co,editor.id,['payroll.view','payroll.edit','payroll.accounting.post','payroll.employee_advance_recovery.view','payroll.employee_advance_recovery.select']);
  await h.member(co,approver.id,['payroll.view','payroll.approve','payroll.accounting.post','employee.view','employee_salary_advance.approve']);
  await h.member(co,poster.id,['payroll.view','payroll.accounting.post','accounting.view','employee_cost.salary.view','payroll.settlement.create','bank.view','bank.reconcile']);
  for(const u of [owner,editor,approver,poster,outsider]) await u.client.login();
  const fy=await h.fiscalYear(co,'FY2026','2026-01-01','2026-12-31');
  const employee=(await h.q<{id:string}>("INSERT INTO employees(company_id,employee_number,display_name,created_by) VALUES($1,'E1','Employee',$2) RETURNING id",[co,owner.id]))[0]!.id;
  const accounts=[]; for(let i=0;i<5;i++) accounts.push(await h.account(co,`A${i}`,i<2?'expense':'liability',i<2?'operating_expense':'current_liability'));
  for(let i=0;i<5;i++) await h.q('INSERT INTO payroll_account_mappings(company_id,mapping_key,account_id,created_by,updated_by) VALUES($1,$2,$3,$4,$4)',[co,keys[i],accounts[i],owner.id]);
  const draft=(await editor.client.req('POST','/payroll/drafts',{month:'2026-03-01'})).json.draft;
  expect((await editor.client.req('PUT',`/payroll/drafts/${draft.id}/employees/${employee}`,values)).status).toBe(200);
  if(approve) expect((await approver.client.req('POST',`/payroll/drafts/${draft.id}/approve`,{version:2})).status).toBe(200);
  const post=()=>poster.client.req('POST',`/payroll/drafts/${draft.id}/accounting-post`,{});
  return {owner,editor,approver,poster,outsider,co,other,fy,employee,accounts,draft,post};
 }
 it('settles SAR 21,000 through payroll and bank without expensing the payroll portion twice',async()=>{
  const x=await fixture('bonus-mixed',false);
  const bonusAccount=await h.account(x.co,'BONUS','liability','current_liability');
  const [bonus]=await h.q<{id:string}>(`
    INSERT INTO employee_bonus_entitlements(company_id,employee_id,request_key,frequency,period_start,period_end,
      eligibility_condition,recognition_condition,calculation_method,calculation_value,basic_salary,
      applicable_allowances,created_by,approved_by,approved_at)
    VALUES($1,$2,$3,'monthly','2026-02-01','2026-02-28','Eligible','Verified','fixed',21000,0,0,$4,$4,now()) RETURNING id
  `,[x.co,x.employee,randomUUID(),x.owner.id]);
  const recognition=await x.owner.client.req('POST',`/employee-bonuses/${bonus!.id}/recognition`,{
    fulfilled_on:'2026-02-28',accounting_date:'2026-02-28',evidence:'Signed evidence',
    expense_account_id:x.accounts[0],liability_account_id:bonusAccount,
  });
  expect(recognition.status,JSON.stringify(recognition.json)).toBe(201);
  const path=`/payroll/drafts/${x.draft.id}`;
  expect((await x.editor.client.req('PUT',`${path}/employees/${x.employee}`,{...values,version:1,bonus:'10000.00'})).status).toBe(200);
  expect((await approveDraft(x)).status).toBe(200);
  const choices=await x.poster.client.req('GET',`${path}/bonus-options`);
  expect(choices.status,JSON.stringify(choices.json)).toBe(200);
  expect(choices.json.options).toEqual([expect.objectContaining({
    entitlement_id:bonus!.id,employee_id:x.employee,maximum:'10000.00',
  })]);
  const post=()=>x.poster.client.req('POST',`${path}/accounting-post`,{bonus_allocations:[{entitlement_id:bonus!.id,amount:'10000'}]});
  const posted=await post();
  expect(posted.status,JSON.stringify(posted.json)).toBe(201);
  expect((await post()).status).toBe(200);
  expect((await x.poster.client.req('GET',`${path}/bonus-options`)).json.options).toEqual([]);
  const lines=await h.q('SELECT account_id,debit::text,credit::text,memo FROM journal_lines WHERE journal_entry_id=$1',[posted.json.journal.id]);
  expect(lines).toContainEqual({account_id:bonusAccount,debit:'10000.00',credit:'0.00',memo:'recognized_bonus_liability'});
  expect(lines).toContainEqual({account_id:x.accounts[0],debit:'100.70',credit:'0.00',memo:'earnings_expense'});
  expect(lines).toContainEqual({account_id:x.accounts[2],debit:'0.00',credit:'10100.20',memo:'net_payroll_liability'});
  const cash=await h.account(x.co,'BANK','asset','current_asset');
  await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1",[cash]);
  const [bank]=await h.q<{id:string}>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Bank','SAR',$2) RETURNING id",[x.co,x.owner.id]);
  await h.q("INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)",[x.co,bank!.id,cash,x.owner.id]);
  async function bankTransaction(amount:string) {
    return (await h.q<{id:string}>(`INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id)
      VALUES($1,$2,'2026-03-10',$3,'SAR','Bonus',$4,$5,'strong','manual','other',$6) RETURNING id`,
      [x.co,bank!.id,amount,randomUUID(),randomUUID().replaceAll('-',''),x.owner.id]))[0]!.id;
  }
  const [liability]=await h.q<{id:string}>('SELECT id FROM journal_lines WHERE journal_entry_id=$1 AND credit>0',[recognition.json.journal_id]);
  const direct={bank_transaction_id:await bankTransaction('-11000'),liability_line_id:liability!.id,amount:'11000',idempotency_key:randomUUID()};
  const cashier=await h.user('bonus-mixed-cashier');
  await h.member(x.co,cashier.id,['payroll.view','payroll.settlement.create','bank.view','bank.reconcile','employee_cost.salary.view']);
  await cashier.client.login();
  const settle=(body:typeof direct)=>cashier.client.req('POST','/payroll/settlements',body);
  const results=await Promise.all([settle(direct),settle(direct)]);
  expect(results.map(r=>r.status).sort(),JSON.stringify(results.map(r=>r.json))).toEqual([200,201]);
  expect((await settle({...direct,bank_transaction_id:await bankTransaction('-1'),amount:'1',idempotency_key:randomUUID()})).status).toBe(409);
  const [payrollLine]=await h.q<{id:string}>("SELECT id FROM journal_lines WHERE journal_entry_id=$1 AND memo='net_payroll_liability'",[posted.json.journal.id]);
  expect((await settle({...direct,liability_line_id:payrollLine!.id,amount:'1',idempotency_key:randomUUID()})).status).toBe(409);
  const payrollPaid=await settle({
    bank_transaction_id:await bankTransaction('-10100.20'),liability_line_id:payrollLine!.id,
    amount:'10100.20',idempotency_key:randomUUID(),
  });
  expect(payrollPaid.status,JSON.stringify(payrollPaid.json)).toBe(201);
  expect(await h.q('SELECT sum(amount)::text amount FROM employee_bonus_balance_entries WHERE company_id=$1 AND entitlement_id=$2',[x.co,bonus!.id])).toEqual([{amount:'21000.00'}]);
  const url=`/employee-bonuses/${bonus!.id}/adjustments`;
  const adjustment={kind:'decrease',amount:'1',accounting_date:'2026-03-11',reason:'Documented correction',idempotency_key:randomUUID()};
  expect((await x.owner.client.req('POST',url,adjustment)).status).toBe(403);
  const adjuster=await h.user('bonus-independent-adjuster');
  await h.member(x.co,adjuster.id,['employee.view','employee_cost.salary.view','employee_cost.correct','employee_cost.approve','accounting.journal.post']);
  await adjuster.client.login();
  const adjust=(body:typeof adjustment)=>adjuster.client.req('POST',url,body);
  expect((await adjust(adjustment)).status).toBe(409);
  const increase={...adjustment,kind:'increase',amount:'20',idempotency_key:randomUUID()};
  const adjusted=await adjust(increase);
  expect(adjusted.status,JSON.stringify(adjusted.json)).toBe(201);
  expect((await adjust(increase)).status).toBe(200);
  expect(await h.q('SELECT account_id,debit::text,credit::text FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence',[adjusted.json.journal_id])).toEqual([
    {account_id:x.accounts[0],debit:'20.00',credit:'0.00'},
    {account_id:bonusAccount,debit:'0.00',credit:'20.00'},
  ]);
  expect((await settle({...direct,bank_transaction_id:await bankTransaction('-5'),amount:'5',idempotency_key:randomUUID()})).status).toBe(201);
  expect((await adjust({...adjustment,amount:'16',idempotency_key:randomUUID()})).status).toBe(409);
  expect((await adjust({...adjustment,amount:'15',idempotency_key:randomUUID()})).status).toBe(201);
  const reverser=await h.user('bonus-independent-reverser');
  await h.member(x.co,reverser.id,['employee.view','employee_cost.salary.view','employee_cost.payment.reverse',
    'accounting.journal.post','bank.view','bank.reconcile']);
  await reverser.client.login();
  const [payment]=await h.q<{id:string}>(`
    SELECT b.id FROM employee_bonus_balance_entries b
    JOIN payroll_settlement_allocations p ON p.company_id=b.company_id AND p.journal_entry_id=b.journal_id
    WHERE b.company_id=$1 AND b.entitlement_id=$2 AND p.bank_transaction_id=$3
  `,[x.co,bonus!.id,direct.bank_transaction_id]);
  const refund={payment_id:payment!.id,bank_transaction_id:await bankTransaction('2000'),amount:'2000',
    reason:'Verified employee refund',idempotency_key:randomUUID()};
  const reverse=()=>reverser.client.req('POST',`/employee-bonuses/${bonus!.id}/bank-reversals`,refund);
  const reversals=await Promise.all([reverse(),reverse()]);
  expect(reversals.map(r=>r.status).sort(),JSON.stringify(reversals.map(r=>r.json))).toEqual([200,201]);
  expect(reversals[0]!.json.journal_id).toBe(reversals[1]!.json.journal_id);
  expect((await reverser.client.req('POST',`/employee-bonuses/${bonus!.id}/bank-reversals`,{
    ...refund,idempotency_key:randomUUID(),
  })).status).toBe(409);
  expect(await h.q('SELECT account_id,debit::text,credit::text FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence',
    [reversals[0]!.json.journal_id])).toEqual([
    {account_id:cash,debit:'2000.00',credit:'0.00'},
    {account_id:bonusAccount,debit:'0.00',credit:'2000.00'},
  ]);
  expect(await h.q(`SELECT (e.amount+sum(CASE WHEN b.kind IN ('increase','reversal') THEN b.amount ELSE -b.amount END))::text outstanding
    FROM employee_bonus_entitlements e JOIN employee_bonus_balance_entries b ON b.company_id=e.company_id AND b.entitlement_id=e.id
    WHERE e.company_id=$1 AND e.id=$2 GROUP BY e.id`,[x.co,bonus!.id])).toEqual([{outstanding:'2000.00'}]);
  const [payrollPayment]=await h.q<{id:string}>(
    "SELECT id FROM employee_bonus_balance_entries WHERE company_id=$1 AND entitlement_id=$2 AND kind='payroll'",
    [x.co,bonus!.id],
  );
  const payrollRefund=await reverser.client.req('POST',`/employee-bonuses/${bonus!.id}/bank-reversals`,{
    ...refund,payment_id:payrollPayment!.id,bank_transaction_id:await bankTransaction('1000'),
    amount:'1000',idempotency_key:randomUUID(),
  });
  expect(payrollRefund.status,JSON.stringify(payrollRefund.json)).toBe(201);
  expect(await h.q("SELECT sum(amount)::text restored FROM employee_bonus_balance_entries WHERE entitlement_id=$1 AND kind='reversal'",[bonus!.id]))
    .toEqual([{restored:'3000.00'}]);




 });
 async function issueAdvance(x:Awaited<ReturnType<typeof fixture>>, amount='25.25', issueDate='2026-03-10'){
  const tag=randomUUID().slice(0,8);
  const receivable=await h.account(x.co,`AR-${tag}`,'asset','current_asset');
  const bankGl=await h.account(x.co,`BK-${tag}`,'asset','current_asset');
  await h.q("INSERT INTO employee_salary_advance_account_mappings(company_id,account_id,updated_by) VALUES($1,$2,$3)",[x.co,receivable,x.owner.id]);
  const bank=(await h.q<{id:string}>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Advance funding','SAR',$2) RETURNING id",[x.co,x.owner.id]))[0]!.id;
  await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1",[bankGl]);
  await h.q("INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)",[x.co,bank,bankGl,x.owner.id]);
  const bankTx=(await h.q<{id:string}>(`INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id)
    VALUES($1,$2,$3,$4,'SAR','Salary advance funding',$5,$6,'strong','manual','other',$7) RETURNING id`,[x.co,bank,issueDate,`-${amount}`,`recovery-${randomUUID()}`,randomUUID().replaceAll('-',''),x.owner.id]))[0]!.id;
  const created=await x.owner.client.req('POST','/employee-salary-advances',{employee_id:x.employee,amount,issue_date:issueDate,description:'Payroll recovery test'});
  expect(created.status,JSON.stringify(created.json)).toBe(201);
  const advanceId=created.json.advance.id as string;
  const approved=await x.approver.client.req('POST',`/employee-salary-advances/${advanceId}/approve`,{version:1});expect(approved.status,JSON.stringify(approved.json)).toBe(200);
  const queued=await x.owner.client.req('POST',`/employee-salary-advances/${advanceId}/issue`,{version:2,bank_transaction_id:bankTx});expect(queued.status,JSON.stringify(queued.json)).toBe(201);
  const fundingJournal=queued.json.journal.id as string;
  const posted=await x.owner.client.req('POST',`/journals/${fundingJournal}/post`,{});expect(posted.status,JSON.stringify(posted.json)).toBe(200);
  return {advanceId,receivable,fundingJournal};
 }
 it('loads a November issued advance while adding an employee to a December draft',async()=>{
  const x=await fixture('recovery-december-add-employee',false),advance=await issueAdvance(x,'1000.00','2026-11-16');
  const draft=(await x.editor.client.req('POST','/payroll/drafts',{month:'2026-12-01'})).json.draft;
  const result=await x.editor.client.req('GET',`/payroll/drafts/${draft.id}/employees/${x.employee}/advance-recoveries`);
  expect(result.status,JSON.stringify(result.json)).toBe(200);
  expect(result.json.advances).toEqual([expect.objectContaining({advance_id:advance.advanceId,original_amount:'1000.00',issue_date:'2026-11-16',available_balance:'1000.00'})]);
  expect(await h.count('SELECT count(*)::text n FROM payroll_draft_employees WHERE company_id=$1 AND draft_id=$2 AND employee_id=$3',[x.co,draft.id,x.employee])).toBe(0);
 });
 async function selectRecovery(x:Awaited<ReturnType<typeof fixture>>,advanceId:string,amount:string,draftId=x.draft.id,employeeId=x.employee){
  const version=(await h.q<{version:number}>("SELECT version FROM payroll_draft_employees WHERE company_id=$1 AND draft_id=$2 AND employee_id=$3",[x.co,draftId,employeeId]))[0]!.version;
  return x.editor.client.req('PUT',`/payroll/drafts/${draftId}/employees/${employeeId}/advance-recoveries`,{version,recoveries:[{advance_id:advanceId,amount}]});
 }
 async function approveDraft(x:Awaited<ReturnType<typeof fixture>>,draftId=x.draft.id){
  const version=(await h.q<{version:number}>('SELECT version FROM payroll_drafts WHERE company_id=$1 AND id=$2',[x.co,draftId]))[0]!.version;
  return x.approver.client.req('POST',`/payroll/drafts/${draftId}/approve`,{version});
 }
 async function makeSecondDraft(x:Awaited<ReturnType<typeof fixture>>,month='2026-04-01'){
  const draft=(await x.editor.client.req('POST','/payroll/drafts',{month})).json.draft;
  const saved=await x.editor.client.req('PUT',`/payroll/drafts/${draft.id}/employees/${x.employee}`,{...values,version:0});expect(saved.status,JSON.stringify(saved.json)).toBe(200);
  return draft.id as string;
 }
 async function correctionActors(x:Awaited<ReturnType<typeof fixture>>,label:string){
  const requester=await h.user(`${label}-requester`),approver=await h.user(`${label}-approver`),poster=await h.user(`${label}-poster`);
  await h.member(x.co,requester.id,['payroll.view','payroll.employee_advance_recovery.correct']);
  await h.member(x.co,approver.id,['payroll.view','payroll.employee_advance_recovery.view','payroll.employee_advance_recovery.correct.approve']);
  await h.member(x.co,poster.id,['payroll.view','payroll.employee_advance_recovery.correct','payroll.accounting.post']);
  for(const u of [requester,approver,poster])await u.client.login();
  return{requester,approver,poster};
 }
 async function correction(actors:Awaited<ReturnType<typeof correctionActors>>,recoveryId:string,amount:string){
  const body={recovery_id:recoveryId,amount,reason:'Correct a verified payroll recovery amount',accounting_date:'2026-03-15',idempotency_key:randomUUID()};
  const req=await actors.requester.client.req('POST','/payroll/recovery-corrections',body);
  expect(req.status,JSON.stringify(req.json)).toBe(201);
  const retry=await actors.requester.client.req('POST','/payroll/recovery-corrections',body);expect(retry.status).toBe(200);expect(retry.json.id).toBe(req.json.id);
  const decision=await actors.approver.client.req('POST',`/payroll/recovery-corrections/${req.json.id}/decision`,{decision:'approve',reason:'Evidence confirms this correction is required'});
  expect(decision.status,JSON.stringify(decision.json)).toBe(200);
  return req.json.id as string;
 }
 it('posts a partial recovery atomically with exact receivable credit and immutable balance evidence',async()=>{
  const x=await fixture('recovery-partial',false),advance=await issueAdvance(x,'25.25');
  const selected=await selectRecovery(x,advance.advanceId,'10.25');expect(selected.status,JSON.stringify(selected.json)).toBe(200);
  expect((await approveDraft(x)).status).toBe(200);
  const posted=await x.post();expect(posted.status,JSON.stringify(posted.json)).toBe(201);
  const journal=posted.json.journal.id as string;
  const lines=await h.q<{account_id:string;debit:string;credit:string;memo:string}>('SELECT account_id,debit::text,credit::text,memo FROM journal_lines WHERE company_id=$1 AND journal_entry_id=$2 ORDER BY sequence',[x.co,journal]);
  expect(lines).toContainEqual({account_id:advance.receivable,debit:'0.00',credit:'10.25',memo:'employee_salary_advance_receivable'});
  expect(lines).toContainEqual({account_id:x.accounts[2],debit:'0.00',credit:'90.25',memo:'net_payroll_liability'});
  expect(lines).toContainEqual({account_id:x.accounts[3],debit:'0.00',credit:'0.50',memo:'employee_deduction_liability'});
  const evidence=(await h.q<{status:string;amount:string;journal_entry_id:string;journal_line_id:string}>('SELECT status,amount::text,journal_entry_id,journal_line_id FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND draft_id=$2',[x.co,x.draft.id]))[0]!;
  expect(evidence).toMatchObject({status:'posted',amount:'10.25',journal_entry_id:journal});expect(lines.some(l=>l.memo==='employee_salary_advance_receivable'&&l.credit==='10.25')).toBe(true);
  expect(await h.count("SELECT COUNT(*)::text n FROM payroll_employee_advance_recoveries WHERE id=$1 AND status='posted' AND journal_line_id=$2",[(await h.q<{id:string}>('SELECT id FROM payroll_employee_advance_recoveries WHERE draft_id=$1',[x.draft.id]))[0]!.id,evidence.journal_line_id])).toBe(1);
  expect(await h.q<{balance:string}>(`SELECT (a.amount-COALESCE(sum(r.amount) FILTER(WHERE r.status='posted'),0))::text balance FROM employee_salary_advances a LEFT JOIN payroll_employee_advance_recoveries r ON r.company_id=a.company_id AND r.advance_id=a.id WHERE a.id=$1 GROUP BY a.id`,[advance.advanceId])).toEqual([{balance:'15.00'}]);
  await expect(h.q("UPDATE payroll_employee_advance_recoveries SET amount=11 WHERE company_id=$1 AND draft_id=$2",[x.co,x.draft.id])).rejects.toThrow(/immutable/);
  expect(await h.count('SELECT COUNT(*)::text n FROM payroll_settlement_allocations WHERE company_id=$1',[x.co])).toBe(0);
 });

 it('rejects over-recovery and allows a full recovery without changing generic deductions',async()=>{
  const x=await fixture('recovery-full',false),advance=await issueAdvance(x,'25.25');
  expect((await selectRecovery(x,advance.advanceId,'25.26')).json.code).toBe('PAYROLL_ADVANCE_BALANCE_EXCEEDED');
  expect((await selectRecovery(x,advance.advanceId,'25.25')).status).toBe(200);expect((await approveDraft(x)).status).toBe(200);
  const result=await x.post();expect(result.status,JSON.stringify(result.json)).toBe(201);
  expect(await h.count("SELECT COUNT(*)::text n FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status='posted' AND amount=25.25",[x.co,advance.advanceId])).toBe(1);
  expect(await h.count("SELECT COUNT(*)::text n FROM journal_lines WHERE journal_entry_id=$1 AND memo='employee_deduction_liability' AND credit=0.50",[result.json.journal.id])).toBe(1);
 });
 it('keeps linked recoveries within edited payroll net pay',async()=>{
  const x=await fixture('recovery-net-bound',false),advance=await issueAdvance(x,'25.25');
  expect((await selectRecovery(x,advance.advanceId,'10.00')).status).toBe(200);
  const line=(await h.q<{version:number}>('SELECT version FROM payroll_draft_employees WHERE company_id=$1 AND draft_id=$2 AND employee_id=$3',[x.co,x.draft.id,x.employee]))[0]!;
  const edit=await x.editor.client.req('PUT',`/payroll/drafts/${x.draft.id}/employees/${x.employee}`,{...values,salary:'1.00',version:line.version});
  expect(edit.status).toBe(409);expect(edit.json.code).toBe('PAYROLL_RECOVERY_EXCEEDS_NET');
  expect((await approveDraft(x)).status).toBe(200);
 });
 it('does not let payroll recovery viewers edit selected recovery amounts without the dedicated select capability',async()=>{
  const x=await fixture('recovery-select-permission',false),advance=await issueAdvance(x);
  const viewer=await h.user('recovery-view-only');await h.member(x.co,viewer.id,['payroll.view','payroll.edit','payroll.employee_advance_recovery.view']);await viewer.client.login();
  const version=(await h.q<{version:number}>('SELECT version FROM payroll_draft_employees WHERE company_id=$1 AND draft_id=$2 AND employee_id=$3',[x.co,x.draft.id,x.employee]))[0]!.version;
  const denied=await viewer.client.req('PUT',`/payroll/drafts/${x.draft.id}/employees/${x.employee}/advance-recoveries`,{version,recoveries:[{advance_id:advance.advanceId,amount:'1.00'}]});
  expect(denied.status).toBe(403);expect(await h.count("SELECT count(*)::text n FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND draft_id=$2",[x.co,x.draft.id])).toBe(0);
 });
 it('rolls back reservation conversion and journal together when canonical posting fails',async()=>{
  const x=await fixture('recovery-rollback',false),advance=await issueAdvance(x),selected=await selectRecovery(x,advance.advanceId,'10.00');expect(selected.status).toBe(200);expect((await approveDraft(x)).status).toBe(200);
  await h.q(`CREATE FUNCTION recovery_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payroll.accounting.post' THEN RAISE EXCEPTION 'test recovery rollback'; END IF; RETURN NEW; END $$`);
  await h.q('CREATE TRIGGER recovery_test_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION recovery_test_fail_audit()');
  try{expect((await x.post()).status).toBe(500);}finally{await h.q('DROP TRIGGER recovery_test_fail_audit ON audit_log');await h.q('DROP FUNCTION recovery_test_fail_audit()');}
  expect(await h.count("SELECT COUNT(*)::text n FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND draft_id=$2 AND status='reserved'",[x.co,x.draft.id])).toBe(1);
  expect(await h.count("SELECT COUNT(*)::text n FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND draft_id=$2 AND status='posted'",[x.co,x.draft.id])).toBe(0);
  expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='payroll' AND source_id=$2",[x.co,x.draft.id])).toBe(0);
 });
 it('releases an approved draft reservation through an audited return-to-draft transition without cancelling the issued advance',async()=>{
  const x=await fixture('recovery-lifecycle',false),advance=await issueAdvance(x,'25.25');
  expect((await selectRecovery(x,advance.advanceId,'10.00')).status).toBe(200);expect((await approveDraft(x)).status).toBe(200);
  expect(await h.count("SELECT count(*)::text n FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status='reserved'",[x.co,advance.advanceId])).toBe(1);
  const lifecycle=await h.user('recovery-lifecycle-independent');await h.member(x.co,lifecycle.id,['payroll.view','payroll.edit','payroll.approve']);await lifecycle.client.login();
  const returned=await lifecycle.client.req('POST',`/payroll/drafts/${x.draft.id}/lifecycle`,{action:'return_to_draft',reason:'Correct the payroll before posting'});
  expect(returned.status,JSON.stringify(returned.json)).toBe(200);expect(returned.json.status).toBe('draft');
  expect(await h.count("SELECT count(*)::text n FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status='released' AND ended_at IS NOT NULL",[x.co,advance.advanceId])).toBe(1);
  expect(await h.count("SELECT count(*)::text n FROM employee_salary_advances WHERE company_id=$1 AND id=$2 AND status='issued' AND journal_entry_id IS NOT NULL",[x.co,advance.advanceId])).toBe(1);
  expect(await h.count("SELECT count(*)::text n FROM audit_log WHERE company_id=$1 AND action='payroll.draft.return_to_draft' AND entity_id=$2",[x.co,x.draft.id])).toBe(1);
  const version=(await h.q<{version:number}>('SELECT version FROM payroll_draft_employees WHERE company_id=$1 AND draft_id=$2 AND employee_id=$3',[x.co,x.draft.id,x.employee]))[0]!.version;
  const reselected=await x.editor.client.req('PUT',`/payroll/drafts/${x.draft.id}/employees/${x.employee}/advance-recoveries`,{version,recoveries:[{advance_id:advance.advanceId,amount:'10.00'}]});expect(reselected.status,JSON.stringify(reselected.json)).toBe(200);
 });
 it('denies draft cancellation without payroll.edit and leaves the draft unchanged',async()=>{
  const x=await fixture('recovery-cancel-permission',false),viewer=await h.user('recovery-cancel-viewer');
  await h.member(x.co,viewer.id,['payroll.view']);await viewer.client.login();
  const denied=await viewer.client.req('POST',`/payroll/drafts/${x.draft.id}/lifecycle`,{action:'cancel',reason:'Cancel this unused payroll draft'});
  expect(denied.status).toBe(403);
  expect((await h.q<{status:string}>('SELECT status FROM payroll_drafts WHERE id=$1 AND company_id=$2',[x.draft.id,x.co]))[0]!.status).toBe('draft');
 });
 it('serializes competing reservations across payroll periods and allows only the remaining balance to post',async()=>{
  const x=await fixture('recovery-concurrency',false),advance=await issueAdvance(x,'25.25'),april=await makeSecondDraft(x,'2026-04-01');
  expect((await selectRecovery(x,advance.advanceId,'15.00')).status).toBe(200);expect((await selectRecovery(x,advance.advanceId,'15.00',april)).status).toBe(200);
  const approvals=await Promise.all([approveDraft(x),approveDraft(x,april)]);expect(approvals.map(r=>r.status).sort()).toEqual([200,409]);
  const winner=approvals[0]!.status===200?x.draft.id:april,loser=winner===x.draft.id?april:x.draft.id;
  const posted=await x.poster.client.req('POST',`/payroll/drafts/${winner}/accounting-post`,{});
  expect(posted.status,JSON.stringify(posted.json)).toBe(201);
  const consumed=(await h.q<{amount:string}>('SELECT sum(amount)::text amount FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status=\'posted\'',[x.co,advance.advanceId]))[0]!.amount;expect(consumed).toBe('15.00');
  expect((await h.q<{available:string}>(`SELECT (a.amount-COALESCE(sum(r.amount) FILTER(WHERE r.status='posted' OR r.status='reserved' AND r.expires_at>clock_timestamp()),0))::text available FROM employee_salary_advances a LEFT JOIN payroll_employee_advance_recoveries r ON r.company_id=a.company_id AND r.advance_id=a.id WHERE a.id=$1 GROUP BY a.id`,[advance.advanceId]))[0]!.available).toBe('10.25');
  const lineVersion=(await h.q<{version:number}>('SELECT version FROM payroll_draft_employees WHERE company_id=$1 AND draft_id=$2 AND employee_id=$3',[x.co,loser,x.employee]))[0]!.version;
  const rebalance=await x.editor.client.req('PUT',`/payroll/drafts/${loser}/employees/${x.employee}/advance-recoveries`,{version:lineVersion,recoveries:[{advance_id:advance.advanceId,amount:'10.25'}]});expect(rebalance.status,JSON.stringify(rebalance.json)).toBe(200);
  expect((await approveDraft(x,loser)).status).toBe(200);
  const loserPost=await x.poster.client.req('POST',`/payroll/drafts/${loser}/accounting-post`,{});expect(loserPost.status,JSON.stringify(loserPost.json)).toBe(201);
  expect(await h.count("SELECT COUNT(*)::text n FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status='posted'",[x.co,advance.advanceId])).toBe(2);
  expect((await h.q<{recovered:string}>("SELECT sum(amount)::text recovered FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status='posted'",[x.co,advance.advanceId]))[0]!.recovered).toBe('25.25');
 });
 it('rejects posting after a reservation lease expires',async()=>{
  const x=await fixture('recovery-expired',false),advance=await issueAdvance(x),april=await makeSecondDraft(x,'2026-04-01');
  expect((await approveDraft(x,april)).status).toBe(200);
  await h.q(`INSERT INTO payroll_employee_advance_recoveries(company_id,draft_id,employee_id,advance_id,amount,status,expires_at,reserved_at,created_by)
   VALUES($1,$2,$3,$4,10,'reserved',clock_timestamp()+interval '1 second',clock_timestamp(),$5)`,[x.co,april,x.employee,advance.advanceId,x.approver.id]);
  await new Promise(resolve=>setTimeout(resolve,1200));
  const reserved=(await h.q<{id:string}>('SELECT id FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND draft_id=$2 AND status=\'reserved\'',[x.co,april]))[0]!,fundingLine=(await h.q<{id:string}>('SELECT id FROM journal_lines WHERE journal_entry_id=$1 LIMIT 1',[advance.fundingJournal]))[0]!;
  await expect(h.q("UPDATE payroll_employee_advance_recoveries SET status='posted',expires_at=NULL,journal_entry_id=$2,journal_line_id=$3 WHERE id=$1",[reserved.id,advance.fundingJournal,fundingLine.id])).rejects.toThrow(/expired payroll recovery reservation cannot post/);
  const result=await x.poster.client.req('POST',`/payroll/drafts/${april}/accounting-post`,{});
  expect(result.status).toBe(409);expect(result.json.code).toBe('PAYROLL_ADVANCE_RESERVATION_EXPIRED');
  expect(await h.count("SELECT COUNT(*)::text n FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND draft_id=$2 AND status='reserved'",[x.co,april])).toBe(1);
  expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='payroll' AND source_id=$2",[x.co,april])).toBe(0);
 });
 it('database rejects forged posted records, wrong employee ownership, and mismatched journal evidence',async()=>{
  const x=await fixture('recovery-db-guards',false),advance=await issueAdvance(x,'25.25');
  await expect(h.q(`INSERT INTO payroll_employee_advance_recoveries(company_id,draft_id,employee_id,advance_id,amount,status,created_by,journal_entry_id,journal_line_id) VALUES($1,$2,$3,$4,1,'posted',$5,$6,$7)`,[x.co,x.draft.id,x.employee,advance.advanceId,x.owner.id,advance.fundingJournal,(await h.q<{id:string}>('SELECT id FROM journal_lines WHERE journal_entry_id=$1 LIMIT 1',[advance.fundingJournal]))[0]!.id])).rejects.toThrow(/only post from an approved reservation/);
  const foreignEmployee=(await h.q<{id:string}>('INSERT INTO employees(company_id,employee_number,display_name,created_by) VALUES($1,$2,\'Wrong owner\',$3) RETURNING id',[x.co,`X${randomUUID().slice(0,6)}`,x.owner.id]))[0]!.id;
  await expect(h.q("INSERT INTO payroll_employee_advance_recoveries(company_id,draft_id,employee_id,advance_id,amount,status,created_by) VALUES($1,$2,$3,$4,1,'selected',$5)",[x.co,x.draft.id,foreignEmployee,advance.advanceId,x.owner.id])).rejects.toThrow(/ownership or lifecycle invalid/);
  expect((await selectRecovery(x,advance.advanceId,'10.00')).status).toBe(200);expect((await approveDraft(x)).status).toBe(200);
  const recovery=(await h.q<{id:string}>('SELECT id FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND draft_id=$2 AND status=\'reserved\'',[x.co,x.draft.id]))[0]!, fundingLine=(await h.q<{id:string}>('SELECT id FROM journal_lines WHERE journal_entry_id=$1 LIMIT 1',[advance.fundingJournal]))[0]!;
  const c=await h.db.connect();try{await c.query('BEGIN');await c.query("UPDATE payroll_employee_advance_recoveries SET status='posted',expires_at=NULL,journal_entry_id=$3,journal_line_id=$4 WHERE company_id=$1 AND id=$2",[x.co,recovery.id,advance.fundingJournal,fundingLine.id]);await expect(c.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(/does not match immutable journal evidence/);await c.query('ROLLBACK');}finally{c.release();}
 });
 it('posts partial and full correction reversals immutably and settles correction liability separately',async()=>{
  const x=await fixture('recovery-correction-settle',false),advance=await issueAdvance(x,'25.25');
  expect((await selectRecovery(x,advance.advanceId,'25.25')).status).toBe(200);expect((await approveDraft(x)).status).toBe(200);
  const payroll=await x.post();expect(payroll.status,JSON.stringify(payroll.json)).toBe(201);
  const recovery=(await h.q<{id:string}>('SELECT id FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status=\'posted\'',[x.co,advance.advanceId]))[0]!.id;
  const actors=await correctionActors(x,'correction-settle');
  const partial=await correction(actors,recovery,'10.00');
  expect((await actors.poster.client.req('POST',`/payroll/recovery-corrections/${partial}/post`,{})).status).toBe(201);
  const full=await correction(actors,recovery,'15.25');
  const postedFull=await actors.poster.client.req('POST',`/payroll/recovery-corrections/${full}/post`,{});expect(postedFull.status,JSON.stringify(postedFull.json)).toBe(201);
  const cjournals=await h.q<{id:string;account_id:string;debit:string;credit:string;memo:string}>('SELECT j.id,l.account_id,l.debit::text,l.credit::text,l.memo FROM journal_entries j JOIN journal_lines l ON l.journal_entry_id=j.id WHERE j.company_id=$1 AND j.source_type=\'payroll_recovery_correction\' ORDER BY j.created_at,l.sequence',[x.co]);
  expect(cjournals).toHaveLength(4);
  expect(cjournals.slice(0,2)).toEqual([{id:cjournals[0]!.id,account_id:advance.receivable,debit:'10.00',credit:'0.00',memo:'employee_salary_advance_recovery_reversal'},{id:cjournals[0]!.id,account_id:x.accounts[2]!,debit:'0.00',credit:'10.00',memo:'employee_salary_advance_payroll_liability_reversal'}]);
  await expect(h.q("UPDATE journal_lines SET debit=debit WHERE journal_entry_id=$1",[cjournals[0]!.id])).rejects.toThrow(/immutable/);
  await expect(h.q("UPDATE payroll_recovery_corrections SET reason='change posted correction' WHERE id=$1",[partial])).rejects.toThrow(/immutable/);
  expect((await actors.requester.client.req('POST','/payroll/recovery-corrections',{recovery_id:recovery,amount:'0.01',reason:'Over the remaining correction amount',accounting_date:'2026-03-15',idempotency_key:randomUUID()})).status).toBe(409);
  expect((await h.q<{remaining:string}>(`SELECT (a.amount-COALESCE(sum(r.amount) FILTER(WHERE r.status='posted'),0)+COALESCE((SELECT sum(c.amount) FROM payroll_recovery_corrections c WHERE c.recovery_id=r.id AND c.status='posted'),0))::text remaining FROM employee_salary_advances a JOIN payroll_employee_advance_recoveries r ON r.advance_id=a.id WHERE a.id=$1 GROUP BY a.amount,r.id`,[advance.advanceId]))[0]!.remaining).toBe('25.25');
  const april=await makeSecondDraft(x,'2026-04-01');expect((await selectRecovery(x,advance.advanceId,'25.25',april)).status).toBe(200);expect((await approveDraft(x,april)).status).toBe(200);
  expect(await h.count("SELECT count(*)::text n FROM journal_entries WHERE id=$1 AND status='posted'",[payroll.json.journal.id])).toBe(1);
  await expect(h.q("UPDATE journal_entries SET description='rewrite' WHERE id=$1",[payroll.json.journal.id])).rejects.toThrow(/immutable/);
  await expect(h.q("UPDATE payroll_employee_advance_recoveries SET amount=1 WHERE id=$1",[recovery])).rejects.toThrow(/immutable/);
  const correctionLine=(await h.q<{id:string}>(`SELECT l.id FROM payroll_recovery_corrections c JOIN journal_lines l ON l.journal_entry_id=c.journal_entry_id AND l.memo='employee_salary_advance_payroll_liability_reversal' WHERE c.id=$1`,[partial]))[0]!.id;
  const settlementActor=await h.user('correction-settlement-actor');await h.member(x.co,settlementActor.id,['payroll.view','payroll.settlement.view','payroll.settlement.create','bank.view']);await settlementActor.client.login();
  const liabilities=await settlementActor.client.req('GET','/payroll/settlements/liabilities');
  expect(liabilities.json.liabilities,JSON.stringify(liabilities)).toEqual(expect.arrayContaining([expect.objectContaining({liability_line_id:correctionLine,category:'employee_salary_advance_payroll_liability_reversal',remaining_amount:'10.00'})]));
  const cash=await h.account(x.co,'CORR-CASH','asset','current_asset');await h.q("UPDATE accounts SET cash_role='cash' WHERE id=$1",[cash]);
  const bank=(await h.q<{id:string}>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Correction settlement','SAR',$2) RETURNING id",[x.co,x.owner.id]))[0]!.id;
  await h.q("INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,'2026-01-01',$4)",[x.co,bank,cash,x.owner.id]);
  const tx=(await h.q<{id:string}>("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id) VALUES($1,$2,'2026-03-20',-10,'SAR','Correction settlement',$3,$4,'strong','manual','other',$5) RETURNING id",[x.co,bank,randomUUID(),randomUUID().replaceAll('-',''),x.owner.id]))[0]!.id;
  const settled=await settlementActor.client.req('POST','/payroll/settlements',{bank_transaction_id:tx,liability_line_id:correctionLine,amount:'4.00',idempotency_key:randomUUID()});expect(settled.status,JSON.stringify(settled.json)).toBe(201);
  expect((await settlementActor.client.req('GET','/payroll/settlements/liabilities')).json.liabilities.find((line:{liability_line_id:string})=>line.liability_line_id===correctionLine).remaining_amount).toBe('6.00');
  expect(await h.count('SELECT count(*)::text n FROM payroll_settlement_allocations WHERE company_id=$1 AND liability_line_id=$2',[x.co,correctionLine])).toBe(1);
 });
 it('serializes competing approved corrections and rolls back posting failures',async()=>{
  const x=await fixture('recovery-correction-race',false),advance=await issueAdvance(x,'25.25');
  expect((await selectRecovery(x,advance.advanceId,'25.25')).status).toBe(200);expect((await approveDraft(x)).status).toBe(200);expect((await x.post()).status).toBe(201);
  const recovery=(await h.q<{id:string}>('SELECT id FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status=\'posted\'',[x.co,advance.advanceId]))[0]!.id;
  const actors=await correctionActors(x,'correction-race');
  const first=await correction(actors,recovery,'10.00'),second=await correction(actors,recovery,'10.00');
  const [a,b]=await Promise.all([actors.poster.client.req('POST',`/payroll/recovery-corrections/${first}/post`,{}),actors.poster.client.req('POST',`/payroll/recovery-corrections/${second}/post`,{})]);
  expect(a.status).toBe(201);expect(b.status,JSON.stringify(b.json)).toBe(201);
  expect((await h.q<{sum:string}>("SELECT COALESCE(sum(amount),0)::text sum FROM payroll_recovery_corrections WHERE recovery_id=$1 AND status='posted'",[recovery]))[0]!.sum).toBe('20.00');
  const failed=await correction(actors,recovery,'5.25');
  await h.q(`CREATE FUNCTION recovery_correction_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payroll.advance_recovery.correction.post' THEN RAISE EXCEPTION 'test correction audit failure'; END IF; RETURN NEW; END $$`);
  await h.q('CREATE TRIGGER recovery_correction_test_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION recovery_correction_test_audit_failure()');
  try{expect((await actors.poster.client.req('POST',`/payroll/recovery-corrections/${failed}/post`,{})).status).toBe(500);}finally{await h.q('DROP TRIGGER recovery_correction_test_audit_failure ON audit_log');await h.q('DROP FUNCTION recovery_correction_test_audit_failure()');}
  expect(await h.count("SELECT count(*)::text n FROM payroll_recovery_corrections WHERE id=$1 AND status='approved' AND journal_entry_id IS NULL",[failed])).toBe(1);
  expect(await h.count("SELECT count(*)::text n FROM journal_entries WHERE source_type='payroll_recovery_correction' AND source_id=$1",[failed])).toBe(0);
 });
 it('allows the correction requester to withdraw an unposted approval with immutable audit evidence and restored capacity',async()=>{
  const x=await fixture('recovery-correction-withdraw',false),advance=await issueAdvance(x,'25.25');
  expect((await selectRecovery(x,advance.advanceId,'25.25')).status).toBe(200);expect((await approveDraft(x)).status).toBe(200);expect((await x.post()).status).toBe(201);
  const recovery=(await h.q<{id:string}>('SELECT id FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status=\'posted\'',[x.co,advance.advanceId]))[0]!.id;
  const actors=await correctionActors(x,'correction-withdraw'),first=await correction(actors,recovery,'15.00');
  const withdrawn=await actors.requester.client.req('POST',`/payroll/recovery-corrections/${first}/withdraw`,{reason:'The approved correction is no longer required'});
  expect(withdrawn.status,JSON.stringify(withdrawn.json)).toBe(200);
  expect(await h.count("SELECT count(*)::text n FROM payroll_recovery_corrections WHERE id=$1 AND status='withdrawn' AND ended_by=$2 AND char_length(end_reason)>=10",[first,actors.requester.id])).toBe(1);
  expect(await h.count("SELECT count(*)::text n FROM audit_log WHERE company_id=$1 AND action='payroll.advance_recovery.correction.withdraw' AND entity_id=$2",[x.co,first])).toBe(1);
  const replacement=await correction(actors,recovery,'15.00');expect((await h.q<{status:string}>('SELECT status FROM payroll_recovery_corrections WHERE id=$1',[replacement]))[0]!.status).toBe('approved');
 });
 it('expires stale correction approvals with an audit record and blocks posting until a fresh request and approval',async()=>{
  const x=await fixture('recovery-correction-expiry',false),advance=await issueAdvance(x,'25.25');
  expect((await selectRecovery(x,advance.advanceId,'25.25')).status).toBe(200);expect((await approveDraft(x)).status).toBe(200);expect((await x.post()).status).toBe(201);
  const recovery=(await h.q<{id:string}>('SELECT id FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status=\'posted\'',[x.co,advance.advanceId]))[0]!.id;
  const actors=await correctionActors(x,'correction-expiry'),id=await correction(actors,recovery,'10.00');
  await h.q('ALTER TABLE payroll_recovery_corrections DISABLE TRIGGER payroll_recovery_correction');
  try{await h.q("UPDATE payroll_recovery_corrections SET approved_at=clock_timestamp()-interval '2 days',approval_expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[id]);}
  finally{await h.q('ALTER TABLE payroll_recovery_corrections ENABLE TRIGGER payroll_recovery_correction');}
  const expired=await actors.poster.client.req('POST',`/payroll/recovery-corrections/${id}/expire`,{});expect(expired.status,JSON.stringify(expired.json)).toBe(200);
  expect(await h.count("SELECT count(*)::text n FROM payroll_recovery_corrections WHERE id=$1 AND status='expired' AND ended_by=$2 AND char_length(end_reason)>=10",[id,actors.poster.id])).toBe(1);
  expect(await h.count("SELECT count(*)::text n FROM audit_log WHERE company_id=$1 AND action='payroll.advance_recovery.correction.expire' AND entity_id=$2",[x.co,id])).toBe(1);
  expect((await actors.poster.client.req('POST',`/payroll/recovery-corrections/${id}/post`,{})).status).toBe(409);
  const fresh=await correction(actors,recovery,'10.00');expect((await h.q<{status:string}>('SELECT status FROM payroll_recovery_corrections WHERE id=$1',[fresh]))[0]!.status).toBe('approved');
  await h.q('ALTER TABLE payroll_recovery_corrections DISABLE TRIGGER payroll_recovery_correction');
  try{await h.q("UPDATE payroll_recovery_corrections SET approved_at=clock_timestamp()-interval '2 days',approval_expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[fresh]);}
  finally{await h.q('ALTER TABLE payroll_recovery_corrections ENABLE TRIGGER payroll_recovery_correction');}
  const stalePost=await actors.poster.client.req('POST',`/payroll/recovery-corrections/${fresh}/post`,{});expect(stalePost.status).toBe(409);expect(stalePost.json.code).toBe('PAYROLL_RECOVERY_CORRECTION_EXPIRED');
  expect(await h.count("SELECT count(*)::text n FROM payroll_recovery_corrections WHERE id=$1 AND status='expired' AND journal_entry_id IS NULL",[fresh])).toBe(1);
 });
 it('requires correction permissions and independent approval apart from payroll participants',async()=>{
  const x=await fixture('recovery-correction-sod',false),advance=await issueAdvance(x,'25.25');
  expect((await selectRecovery(x,advance.advanceId,'10.00')).status).toBe(200);expect((await approveDraft(x)).status).toBe(200);expect((await x.post()).status).toBe(201);
  const recovery=(await h.q<{id:string}>('SELECT id FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status=\'posted\'',[x.co,advance.advanceId]))[0]!.id;
  const actors=await correctionActors(x,'correction-sod');
  expect((await x.editor.client.req('POST','/payroll/recovery-corrections',{recovery_id:recovery,amount:'1.00',reason:'No correction capability assigned',accounting_date:'2026-03-15',idempotency_key:randomUUID()})).status).toBe(403);
  const requested=await actors.requester.client.req('POST','/payroll/recovery-corrections',{recovery_id:recovery,amount:'5.00',reason:'Correct an evidence-backed payroll recovery',accounting_date:'2026-03-15',idempotency_key:randomUUID()});expect(requested.status).toBe(201);
  const inbox=await actors.approver.client.req('GET','/payroll/recovery-corrections');expect(inbox.status).toBe(200);expect(inbox.json.corrections.some((row:{id:string;status:string;privileged_financial_authority_current_user:boolean})=>row.id===requested.json.id&&row.status==='pending'&&!row.privileged_financial_authority_current_user)).toBe(true);
  await h.q("INSERT INTO role_capabilities(role_id,capability_id) SELECT role_id,'payroll.employee_advance_recovery.correct.approve' FROM memberships WHERE company_id=$1 AND user_id=$2 ON CONFLICT DO NOTHING",[x.co,actors.requester.id]);
  expect((await actors.requester.client.req('POST',`/payroll/recovery-corrections/${requested.json.id}/decision`,{decision:'approve',reason:'I requested this correction myself'})).json.code).toBe('PAYROLL_RECOVERY_CORRECTION_SELF_APPROVAL');
  await h.q("INSERT INTO role_capabilities(role_id,capability_id) SELECT role_id,'payroll.employee_advance_recovery.correct.approve' FROM memberships WHERE company_id=$1 AND user_id=$2 ON CONFLICT DO NOTHING",[x.co,x.approver.id]);
  expect((await x.approver.client.req('POST',`/payroll/recovery-corrections/${requested.json.id}/decision`,{decision:'approve',reason:'I approved the original payroll'})).json.code).toBe('PAYROLL_RECOVERY_CORRECTION_CONFLICTED_APPROVER');
  expect((await actors.approver.client.req('POST',`/payroll/recovery-corrections/${requested.json.id}/decision`,{decision:'approve',reason:'Independent review confirms correction'})).status).toBe(200);
  expect((await actors.approver.client.req('POST',`/payroll/recovery-corrections/${requested.json.id}/post`,{})).status).toBe(403);
  expect((await actors.poster.client.req('POST',`/payroll/recovery-corrections/${requested.json.id}/post`,{})).status).toBe(201);
 });
 it.each(['system_admin','company_manager','finance_manager'] as const)('%s may request, approve and post its own recovery correction',async role=>{
  const x=await fixture(`correction-privileged-${role}`,false),advance=await issueAdvance(x,'25.25');
  expect((await selectRecovery(x,advance.advanceId,'10.00')).status).toBe(200);
  expect((await approveDraft(x)).status).toBe(200);
  expect((await x.post()).status).toBe(201);
  const recovery=(await h.q<{id:string}>("SELECT id FROM payroll_employee_advance_recoveries WHERE company_id=$1 AND advance_id=$2 AND status='posted'",[x.co,advance.advanceId]))[0]!.id;
  const actor=await h.user(`correction-privileged-${role}-actor`);
  if(role==='system_admin')await h.q('UPDATE users SET is_system_admin=TRUE,system_admin_policy_version=1 WHERE id=$1',[actor.id]);
  else {
   const policyRole=(await h.q<{id:string}>('SELECT id FROM roles WHERE company_id=$1 AND authorization_policy_key=$2',[x.co,role]))[0]!;
   await h.q('UPDATE roles SET authorization_policy_version=1 WHERE id=$1',[policyRole.id]);
   await h.q('INSERT INTO memberships(user_id,company_id,role_id) VALUES($1,$2,$3)',[actor.id,x.co,policyRole.id]);

  }
  await actor.client.login();
      if (role === 'system_admin') expect((await actor.client.req('POST', '/auth/switch-company', { companyId: x.co })).status).toBe(200);
  const requested=await actor.client.req('POST','/payroll/recovery-corrections',{recovery_id:recovery,amount:'5.00',reason:'Correct verified recovery',accounting_date:'2026-03-15',idempotency_key:randomUUID()});
  expect(requested.status,JSON.stringify(requested.json)).toBe(201);
  const id=requested.json.id;
  const inbox=await actor.client.req('GET','/payroll/recovery-corrections');
  expect(inbox.status).toBe(200);
  expect(inbox.json.corrections.find((row:{id:string})=>row.id===id)?.privileged_financial_authority_current_user).toBe(true);
  const approved=await actor.client.req('POST',`/payroll/recovery-corrections/${id}/decision`,{decision:'approve',reason:'Verified correction evidence'});
  expect(approved.status,JSON.stringify(approved.json)).toBe(200);
  const posted=await actor.client.req('POST',`/payroll/recovery-corrections/${id}/post`,{});
  expect(posted.status,JSON.stringify(posted.json)).toBe(201);
  expect(await h.count("SELECT COUNT(*)::text n FROM payroll_recovery_corrections WHERE id=$1 AND company_id=$2 AND status='posted' AND requested_by=$3 AND approved_by=$3 AND posted_by=$3",[id,x.co,actor.id])).toBe(1);
 });
 it('posts exact balanced amounts once under concurrency and includes the journal in reports',async()=>{
  const x=await fixture('post-success');
  const ecc=(await h.q<{id:string}>(`INSERT INTO employee_cost_records(company_id,employee_id,category,nature,currency_code,total_amount,service_period_start,service_period_end,description,created_by) VALUES($1,$2,'other','employer_cost','SAR',7,'2026-03-01','2026-03-31','Operational allocation',$3) RETURNING id`,[x.co,x.employee,x.owner.id]))[0]!.id;
  await h.q("INSERT INTO employee_cost_allocations(company_id,cost_record_id,fiscal_year_id,allocation_month,amount) VALUES($1,$2,$3,'2026-03-01',7)",[x.co,ecc,x.fy]);
  await h.q("UPDATE employee_cost_records SET status='approved',approved_by=$2,approved_at=NOW() WHERE id=$1",[ecc,x.owner.id]);
  const [a,b]=await Promise.all([x.post(),x.post()]);
  expect([a.status,b.status].sort()).toEqual([200,201]); expect(a.json.journal.id).toBe(b.json.journal.id);
  expect((await x.post()).json).toMatchObject({existing:true,journal:{id:a.json.journal.id}});
  const rows=await h.q<{account_id:string;debit:string;credit:string}>('SELECT account_id,debit::text,credit::text FROM journal_lines WHERE journal_entry_id=$1 ORDER BY sequence',[a.json.journal.id]);
  expect(rows).toEqual(x.accounts.map((id,i)=>({account_id:id,debit:['101.00','0.60','0.00','0.00','0.00'][i],credit:['0.00','0.00','100.50','0.50','0.60'][i]})));
  expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='payroll' AND source_id=$2 AND status='posted'",[x.co,x.draft.id])).toBe(1);
  expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action='payroll.accounting.post' AND entity_id=$2",[x.co,x.draft.id])).toBe(1);
  const report=await x.poster.client.req('GET',`/financial-statements/profit-or-loss?fiscal_year_id=${x.fy}&start_date=2026-03-01&end_date=2026-03-31`);
  expect(report.status).toBe(200); expect(JSON.stringify(report.json)).toContain('101.60');
  expect(await h.count('SELECT COUNT(*)::text n FROM employee_cost_records WHERE company_id=$1',[x.co])).toBe(1);
  expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1',[x.co])).toBe(1);
 });
 it('posts payroll when unrelated source-less journals exist and reports them only as warnings',async()=>{
  const x=await fixture('post-unrelated-manual');
  await h.postedJournal(x.co,x.fy,'2026-03-20',x.owner.id,[[x.accounts[0]!, '1.00','0.00'],[x.accounts[2]!, '0.00','1.00']]);
  const status=await x.poster.client.req('GET',`/payroll/drafts/${x.draft.id}/accounting-post-status`);
  expect(status.status).toBe(200);
  expect(status.json.eligible).toBe(true);
  expect(status.json.blockers).toEqual([]);
  expect(status.json.warnings).toContainEqual({code:'manual_journal_review',count:1});
  const posted=await x.post();
  expect(posted.status,JSON.stringify(posted.json)).toBe(201);
  expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='payroll' AND source_id=$2 AND status='posted'",[x.co,x.draft.id])).toBe(1);
 });
 it('requires explicit authority, isolates companies, enforces separation and approval',async()=>{
  const x=await fixture('post-auth',false), url=`/payroll/drafts/${x.draft.id}/accounting-post`;
  expect((await x.owner.client.req('POST',url,{})).status).toBe(403);
  expect((await x.outsider.client.req('POST',url,{})).status).toBe(403);
  const foreign=await h.user('foreign-poster'); await h.member(x.other,foreign.id,['payroll.view','payroll.accounting.post']); await foreign.client.login();
  expect((await foreign.client.req('POST',url,{})).status).toBe(404);
  expect((await x.editor.client.req('POST',url,{})).json.code).toBe('PAYROLL_POST_SEPARATION_OF_DUTIES');
  expect((await x.post()).json.code).toBe('PAYROLL_NOT_APPROVED');
  expect((await x.approver.client.req('POST',`/payroll/drafts/${x.draft.id}/approve`,{version:2})).status).toBe(200);
  expect((await x.approver.client.req('POST',url,{})).json.code).toBe('PAYROLL_POST_SEPARATION_OF_DUTIES');
 });
 it.each(['company_manager','finance_manager','system_admin'] as const)('allows %s authority to approve and post its own payroll contribution',async(authority)=>{
  const x=await fixture(`post-${authority}`,false);
  if(authority==='system_admin')await h.q('UPDATE users SET is_system_admin=TRUE,system_admin_policy_version=1 WHERE id=$1',[x.editor.id]);
  else {
   let role=(await h.q<{id:string}>('SELECT id FROM roles WHERE company_id=$1 AND authorization_policy_key=$2 LIMIT 1',[x.co,authority]))[0];
   if(!role)role=(await h.q<{id:string}>("UPDATE roles r SET authorization_policy_key=$3 FROM memberships m WHERE m.role_id=r.id AND m.company_id=r.company_id AND m.company_id=$1 AND m.user_id=$2 RETURNING r.id",[x.co,x.editor.id,authority]))[0];
   expect(role).toBeTruthy();
   await h.q('UPDATE memberships SET role_id=$3 WHERE company_id=$1 AND user_id=$2',[x.co,x.editor.id,role!.id]);
   for(const capability of ['payroll.view','payroll.edit','payroll.approve','payroll.accounting.post'])await h.q('INSERT INTO role_capabilities(role_id,capability_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[role!.id,capability]);
  }
  expect((await x.editor.client.req('POST',`/payroll/drafts/${x.draft.id}/approve`,{version:2})).status).toBe(200);
  const status=await x.editor.client.req('GET',`/payroll/drafts/${x.draft.id}/accounting-post-status`);
  expect(status.status).toBe(200);expect(status.json.eligible).toBe(true);
  const result=await x.editor.client.req('POST',`/payroll/drafts/${x.draft.id}/accounting-post`,{});
  expect(result.status,JSON.stringify(result.json)).toBe(201);
 });
 it('revalidates mappings, manual journals and periods; failed attempts leave no journal and can be retried',async()=>{
  const x=await fixture('post-block');
  await h.q('DELETE FROM payroll_account_mappings WHERE company_id=$1 AND mapping_key=$2',[x.co,keys[0]]);
  expect((await x.post()).json.details).toContainEqual(expect.objectContaining({code:'mapping_missing'}));
  await h.q('INSERT INTO payroll_account_mappings(company_id,mapping_key,account_id,created_by,updated_by) VALUES($1,$2,$3,$4,$4)',[x.co,keys[0],x.accounts[0],x.owner.id]);
  await h.q('UPDATE accounts SET is_active=FALSE WHERE id=$1',[x.accounts[0]]);
  expect((await x.post()).json.details).toContainEqual(expect.objectContaining({code:'mapping_account_inactive'}));
  await h.q('UPDATE accounts SET is_active=TRUE WHERE id=$1',[x.accounts[0]]);
  await h.q('UPDATE payroll_account_mappings SET account_id=$3 WHERE company_id=$1 AND mapping_key=$2',[x.co,keys[0],x.accounts[2]]);
  expect((await x.post()).json.details).toContainEqual(expect.objectContaining({code:'mapping_account_type_invalid'}));
  await h.q('UPDATE payroll_account_mappings SET account_id=$3 WHERE company_id=$1 AND mapping_key=$2',[x.co,keys[0],x.accounts[0]]);
  const manual=(await h.q<{id:string}>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by) VALUES($1,$2,'2026-03-20','Review',$3) RETURNING id",[x.co,x.fy,x.owner.id]))[0]!.id;
  const status=await x.poster.client.req('GET',`/payroll/drafts/${x.draft.id}/accounting-post-status`);
  expect(status.json.eligible).toBe(true);
  expect(status.json.blockers).toEqual([]);
  expect(status.json.warnings).toContainEqual({code:'manual_journal_review',count:1});
  await h.q('DELETE FROM journal_entries WHERE id=$1',[manual]);
  await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1",[x.fy]);
  expect((await x.post()).json.code).toBe('PAYROLL_PERIOD_INELIGIBLE');
  await h.q("UPDATE fiscal_years SET status='open' WHERE id=$1",[x.fy]);
  const period=(await h.q<{id:string}>("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,'2026-03-01','2026-03-31','closed') RETURNING id",[x.co,x.fy]))[0]!.id;
  expect((await x.post()).json.code).toBe('PAYROLL_PERIOD_INELIGIBLE');
  await h.q('DELETE FROM monthly_close_periods WHERE id=$1',[period]);
  expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='payroll'",[x.co])).toBe(0);
  expect((await x.post()).status).toBe(201);
 });
 it.each(['salary','employee_deduction'])('blocks approved ECC %s overlap',async(category)=>{
  const x=await fixture(`post-ecc-${category}`);
  const cost=(await h.q<{id:string}>(`INSERT INTO employee_cost_records(company_id,employee_id,category,nature,currency_code,total_amount,service_period_start,service_period_end,description,created_by) VALUES($1,$2,$3,$4,'SAR',1,'2026-03-01','2026-03-31','ECC',$5) RETURNING id`,[x.co,x.employee,category,category==='salary'?'earning':'employee_deduction',x.owner.id]))[0]!.id;
  await h.q("INSERT INTO employee_cost_allocations(company_id,cost_record_id,fiscal_year_id,allocation_month,amount) VALUES($1,$2,$3,'2026-03-01',1)",[x.co,cost,x.fy]);
  await h.q("UPDATE employee_cost_records SET status='approved',approved_by=$2,approved_at=NOW() WHERE id=$1",[cost,x.owner.id]);
  const result=await x.post(); expect(result.status).toBe(409);expect(result.json.details).toContainEqual(expect.objectContaining({code:category==='salary'?'ecc_overlap':'ecc_employee_deduction_overlap'}));
 });
 it('rolls back journal, lines and audit if the final audit write fails, then permits retry',async()=>{
  const x=await fixture('post-rollback');
  await h.q(`CREATE FUNCTION payroll_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payroll.accounting.post' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`);
  await h.q('CREATE TRIGGER payroll_test_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION payroll_test_fail_audit()');
  try { expect((await x.post()).status).toBe(500); } finally { await h.q('DROP TRIGGER payroll_test_fail_audit ON audit_log'); await h.q('DROP FUNCTION payroll_test_fail_audit()'); }
  expect(await h.count("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND source_type='payroll'",[x.co])).toBe(0);
  expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action IN ('journal.create','journal.post','payroll.accounting.post')",[x.co])).toBe(0);
  expect((await x.post()).status).toBe(201);
 });
 it('orders ECC approval and payroll posting on the company/month lock',async()=>{
  const x=await fixture('post-ecc-race');
  const ecc=await h.user('ecc-approver'); await h.member(x.co,ecc.id,['employee.view','employee_cost.approve','employee_cost.salary.view']); await ecc.client.login();
  const cost=(await h.q<{id:string}>(`INSERT INTO employee_cost_records(company_id,employee_id,category,nature,currency_code,total_amount,service_period_start,service_period_end,description,created_by) VALUES($1,$2,'salary','earning','SAR',1,'2026-03-01','2026-03-31','ECC',$3) RETURNING id`,[x.co,x.employee,x.owner.id]))[0]!.id;
  await h.q("INSERT INTO employee_cost_allocations(company_id,cost_record_id,fiscal_year_id,allocation_month,amount) VALUES($1,$2,$3,'2026-03-01',1)",[x.co,cost,x.fy]);
  const lock=await h.db.connect(); await lock.query('BEGIN'); await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`payroll-ecc:${x.co}:2026-03`]);
  const lockPid=(await lock.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  const approval=ecc.client.req('POST',`/employee-costs/${cost}/approve`,{version:1});
  try {
    let waiting=false; for(let i=0;i<100;i++){const rows=await h.q<{waiting:boolean}>("SELECT EXISTS(SELECT 1 FROM pg_locks w JOIN pg_locks held ON held.locktype=w.locktype AND held.classid=w.classid AND held.objid=w.objid AND held.objsubid=w.objsubid WHERE held.pid=$1 AND held.granted AND w.locktype='advisory' AND NOT w.granted) waiting",[lockPid]);if(rows[0]!.waiting){waiting=true;break;}await new Promise(r=>setTimeout(r,20));} if(!waiting) throw new Error('ECC approval did not wait for the company/month lock');
    const posting=x.post(); await lock.query('COMMIT');
    expect((await approval).status).toBe(200); const result=await posting; expect(result.status).toBe(409); expect(result.json.details).toContainEqual(expect.objectContaining({code:'ecc_overlap'}));
  } finally { await lock.query('ROLLBACK'); lock.release(); }
 });

 it('canonical posting rejects missing payroll context and mismatched payroll lines',async()=>{
  const x=await fixture('post-canonical'); const client=await h.db.connect();
  try {
   await client.query('BEGIN');
   const journal=(await client.query<{id:string}>("INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,source_type,source_id,created_by) VALUES($1,$2,'2026-03-01','Payroll','payroll',$3,$4) RETURNING id",[x.co,x.fy,x.draft.id,x.poster.id])).rows[0]!.id;
   await client.query("INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,1,0,1),($1,$2,$4,0,1,2)",[x.co,journal,x.accounts[0],x.accounts[2]]);
   const {postJournalInTransaction}=await import('../src/modules/accounting/journal-posting');
   await expect(postJournalInTransaction(client,x.co,x.poster.id,journal)).rejects.toThrow('Payroll journals can only be posted');
   await expect(postJournalInTransaction(client,x.co,x.poster.id,journal,{payrollDraftId:x.draft.id})).rejects.toThrow('Payroll journals can only be posted');
  } finally {await client.query('ROLLBACK');client.release();}
 });

 const payrollCategories=['salary','allowances','bonus','overtime','employer_gosi','employee_deduction'] as const;
 const costBody=(fy:string,category:string,month='2026-03-01',currency='SAR')=>({category,nature:category==='employee_deduction'?'employee_deduction':['salary','allowances','bonus','overtime'].includes(category)?'earning':'employer_cost',currency_code:currency,total_amount:'1.00',service_period_start:month,service_period_end:month,description:'Cost allocation',allocations:[{fiscal_year_id:fy,allocation_month:month,amount:'1.00'}]});
 it('blocks each payroll category from ECC approval after posting but permits unrelated allocations',async()=>{
  const x=await fixture('ecc-after-post'); expect((await x.post()).status).toBe(201);
  const reportBefore=await x.poster.client.req('GET',`/financial-statements/profit-or-loss?fiscal_year_id=${x.fy}&start_date=2026-03-01&end_date=2026-03-31`);
  for(const category of payrollCategories){
   const draft=await x.owner.client.req('POST','/employee-costs',{employee_id:x.employee,record:costBody(x.fy,category)}); expect(draft.status,category).toBe(201);
   const result=await x.owner.client.req('POST',`/employee-costs/${draft.json.record.id}/approve`,{version:1});
   expect(result.status,category).toBe(409);expect(result.json.code).toBe('EMPLOYEE_COST_PAYROLL_POSTED_OVERLAP');
   expect(await h.count("SELECT COUNT(*)::text n FROM employee_cost_records WHERE id=$1 AND status='draft'",[draft.json.record.id])).toBe(1);
   expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='employee_cost.approve'",[draft.json.record.id])).toBe(0);
  }
  const otherEmployee=(await h.q<{id:string}>("INSERT INTO employees(company_id,employee_number,display_name,created_by) VALUES($1,'E2','Other',$2) RETURNING id",[x.co,x.owner.id]))[0]!.id;
  for(const [employee,record] of [[x.employee,costBody(x.fy,'other')],[x.employee,costBody(x.fy,'salary','2026-02-01')],[x.employee,costBody(x.fy,'salary','2026-03-01','USD')],[otherEmployee,costBody(x.fy,'salary')]] as const){
   const draft=await x.owner.client.req('POST','/employee-costs',{employee_id:employee,record});expect(draft.status).toBe(201);
   expect((await x.owner.client.req('POST',`/employee-costs/${draft.json.record.id}/approve`,{version:1})).status).toBe(200);
  }
  expect((await x.poster.client.req('GET',`/financial-statements/profit-or-loss?fiscal_year_id=${x.fy}&start_date=2026-03-01&end_date=2026-03-31`)).json).toEqual(reportBefore.json);
  expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1',[x.co])).toBe(1);
 });
 it('rolls back conflicting corrections after posting for every payroll category and allows unrelated corrections',async()=>{
  const x=await fixture('ecc-correction-after');expect((await x.post()).status).toBe(201);
  for(const category of payrollCategories){
   const draft=await x.owner.client.req('POST','/employee-costs',{employee_id:x.employee,record:costBody(x.fy,'other')});expect(draft.status).toBe(201);
   const id=draft.json.record.id;expect((await x.owner.client.req('POST',`/employee-costs/${id}/approve`,{version:1})).status).toBe(200);
   const result=await x.owner.client.req('POST',`/employee-costs/${id}/corrections`,{reason:'Correction',record:costBody(x.fy,category)});
   expect(result.status,category).toBe(409);expect(result.json.code).toBe('EMPLOYEE_COST_PAYROLL_POSTED_OVERLAP');
   expect(await h.count('SELECT COUNT(*)::text n FROM employee_cost_records WHERE company_id=$1 AND supersedes_id=$2',[x.co,id])).toBe(0);
   expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE entity_id=$1 AND action='employee_cost.corrected'",[id])).toBe(0);
   expect(await h.count("SELECT COUNT(*)::text n FROM employee_cost_records WHERE id=$1 AND status='approved'",[id])).toBe(1);
  }
  const draft=await x.owner.client.req('POST','/employee-costs',{employee_id:x.employee,record:costBody(x.fy,'other')});const id=draft.json.record.id;
  expect((await x.owner.client.req('POST',`/employee-costs/${id}/approve`,{version:1})).status).toBe(200);
  expect((await x.owner.client.req('POST',`/employee-costs/${id}/corrections`,{reason:'Allowed',record:costBody(x.fy,'medical_insurance')})).status).toBe(201);
  // A legacy overlap is left intact; correcting it to an unrelated category remains possible.
  const legacy=(await h.q<{id:string}>(`INSERT INTO employee_cost_records(company_id,employee_id,category,nature,currency_code,total_amount,service_period_start,service_period_end,description,created_by) VALUES($1,$2,'salary','earning','SAR',1,'2026-03-01','2026-03-31','Legacy',$3) RETURNING id`,[x.co,x.employee,x.owner.id]))[0]!.id;
  await h.q("INSERT INTO employee_cost_allocations(company_id,cost_record_id,fiscal_year_id,allocation_month,amount) VALUES($1,$2,$3,'2026-03-01',1)",[x.co,legacy,x.fy]);
  await h.q("UPDATE employee_cost_records SET status='approved',approved_by=$2,approved_at=NOW() WHERE id=$1",[legacy,x.owner.id]);
  expect((await x.owner.client.req('POST',`/employee-costs/${legacy}/corrections`,{reason:'Resolve legacy overlap',record:costBody(x.fy,'other')})).status).toBe(201);
  expect(await h.count("SELECT COUNT(*)::text n FROM employee_cost_records WHERE id=$1 AND status='approved' AND category='salary'",[legacy])).toBe(1);
  expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1',[x.co])).toBe(1);
 });
 it('orders payroll before a concurrent ECC approval and rejects the later overlap',async()=>{
  const x=await fixture('payroll-before-ecc');
  const draft=await x.owner.client.req('POST','/employee-costs',{employee_id:x.employee,record:costBody(x.fy,'salary')});expect(draft.status).toBe(201);
  const lock=await h.db.connect();await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`payroll-ecc:${x.co}:2026-03`]);
  const pid=(await lock.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  const waiters=async()=>Number((await h.q<{n:string}>(`SELECT COUNT(*)::text n FROM pg_locks w JOIN pg_locks held ON held.locktype=w.locktype AND held.classid=w.classid AND held.objid=w.objid AND held.objsubid=w.objsubid WHERE held.pid=$1 AND held.granted AND w.locktype='advisory' AND NOT w.granted`,[pid]))[0]!.n);
  const waitFor=async(n:number)=>{for(let i=0;i<150;i++){if(await waiters()>=n)return;await new Promise(r=>setTimeout(r,20));}throw Error(`Expected ${n} waiters`);};
  try {
   const posting=x.post();await waitFor(1);
   const approval=x.owner.client.req('POST',`/employee-costs/${draft.json.record.id}/approve`,{version:1});await waitFor(2);
   await lock.query('COMMIT');expect((await posting).status).toBe(201);
   const result=await approval;expect(result.status).toBe(409);expect(result.json.code).toBe('EMPLOYEE_COST_PAYROLL_POSTED_OVERLAP');
   expect(await h.count("SELECT COUNT(*)::text n FROM employee_cost_records WHERE id=$1 AND status='draft'",[draft.json.record.id])).toBe(1);
   expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1',[x.co])).toBe(1);
  } finally {await lock.query('ROLLBACK');lock.release();}
 });

});
