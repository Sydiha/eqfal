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
  await h.member(co,editor.id,['payroll.view','payroll.edit','payroll.accounting.post']);
  await h.member(co,approver.id,['payroll.view','payroll.approve','payroll.accounting.post']);
  await h.member(co,poster.id,['payroll.view','payroll.accounting.post','accounting.view']);
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
  if(authority==='system_admin')await h.q('UPDATE users SET is_system_admin=TRUE WHERE id=$1',[x.editor.id]);
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
  expect((await x.post()).json.details).toContainEqual(expect.objectContaining({code:'manual_journal_review'}));
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
