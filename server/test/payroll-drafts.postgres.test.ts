import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { startHarness } from './helpers/http-pg';
const describeDatabase=process.env['DATABASE_URL']?describe:describe.skip;
type Harness=Awaited<ReturnType<typeof startHarness>>;
const values=(version:number,salary='100.10')=>({version,salary,housing_allowance:'0.10',transportation_allowance:'0.05',other_allowance:'0.05',bonus:'0.30',overtime:'0.40',deductions:'0.50',employer_contributions:'0.60'});
describeDatabase('PAYROLL-01A PostgreSQL',()=>{
 let h:Harness;beforeAll(async()=>{h=await startHarness();});afterAll(()=>h.close());
 it('migrates a legacy allowance row without changing its amount or assigning a category',async()=>{
  const c=await h.db.connect();
  try{
   await c.query('CREATE TEMP TABLE payroll_draft_employees (allowances NUMERIC(18,2) NOT NULL)');
   await c.query("INSERT INTO payroll_draft_employees(allowances) VALUES('123.45')");
   await c.query(readFileSync(resolve(__dirname,'../migrations/115_payroll_allowance_breakdown.sql'),'utf8'));
   const row=(await c.query('SELECT allowances::text,legacy_allowances::text,housing_allowance::text,transportation_allowance::text,other_allowance::text FROM payroll_draft_employees')).rows[0];
   expect(row).toEqual({allowances:'123.45',legacy_allowances:null,housing_allowance:'0.00',transportation_allowance:'0.00',other_allowance:'0.00'});
  }finally{await c.query('DROP TABLE IF EXISTS pg_temp.payroll_draft_employees');c.release();}
 });
 it('covers migration, company isolation, permissions, duplicate months, concurrent edits, exact totals and audit privacy',async()=>{
  const owner=await h.user('payroll-owner'),viewer=await h.user('payroll-viewer'),editor=await h.user('payroll-editor'),auditor=await h.user('payroll-auditor'),outsider=await h.user('payroll-outsider');
  const co=await h.company('payroll-main',owner.id);await h.company('payroll-other',outsider.id);
  await h.member(co,viewer.id,['payroll.view']);await h.member(co,editor.id,['payroll.view','payroll.edit']);await h.member(co,auditor.id,['audit.view']);
  for(const u of [owner,viewer,editor,auditor,outsider])await u.client.login();
  expect(await h.count("SELECT COUNT(*)::text n FROM information_schema.tables WHERE table_name IN ('payroll_drafts','payroll_draft_employees')")).toBe(2);
  const employee=(await owner.client.req('POST','/employees',{employee_number:'P1',display_name:'Employee',employment_start:'2025-01-01',employment_end:null})).json;
  expect((await viewer.client.req('GET','/payroll/drafts?month=2026-03-01')).status).toBe(200);
  expect((await viewer.client.req('POST','/payroll/drafts',{month:'2026-03-01'})).status).toBe(403);
  const created=await editor.client.req('POST','/payroll/drafts',{month:'2026-03-01'});expect(created.status).toBe(201);const id=created.json.draft.id;
  expect((await owner.client.req('POST','/payroll/drafts',{month:'2026-03-01'})).status).toBe(409);
  expect((await outsider.client.req('GET','/payroll/drafts?month=2026-03-01')).json.draft).toBeNull();
  const url=`/payroll/drafts/${id}/employees/${employee.id}`;
  expect((await viewer.client.req('PUT',url,values(0))).status).toBe(403);
  expect((await outsider.client.req('PUT',url,values(0))).status).toBe(404);
  const pair=await Promise.all([owner.client.req('PUT',url,values(0)),editor.client.req('PUT',url,values(0,'200.10'))]);expect(pair.map(x=>x.status).sort()).toEqual([200,409]);
  const update=await owner.client.req('PUT',url,values(1,'0.10'));expect(update.status).toBe(200);
  expect(update.json.draft).toMatchObject({gross_earnings:'1.00',employee_deductions:'0.50',employer_contributions:'0.60',net_payable:'0.50'});
  expect(update.json.employees[0]).toMatchObject({allowances:'0.20',legacy_allowances:'0.00',housing_allowance:'0.10',transportation_allowance:'0.05',other_allowance:'0.05'});
  expect((await owner.client.req('PUT',url,{...values(2),allowances:'999.00'})).status).toBe(400);
  expect((await owner.client.req('PUT',url,{...values(2),housing_allowance:'0.001'})).status).toBe(400);
  expect((await owner.client.req('PUT',url,{...values(2),housing_allowance:'-1'})).status).toBe(400);
  expect((await owner.client.req('PUT',url,{...values(2),deductions:'999.00'})).status).toBe(400);
  expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action LIKE 'payroll.%'",[co])).toBe(3);
  const events=await h.q<{actor_user_id:string;before_data:Record<string,string>|null;after_data:Record<string,string>|null}>("SELECT actor_user_id,before_data,after_data FROM audit_log WHERE company_id=$1 AND action='payroll.draft_employee.update'",[co]);
  expect(events[0]).toMatchObject({actor_user_id:owner.id,before_data:{salary:expect.any(String)},after_data:{salary:'0.10'}});
  expect((await auditor.client.req('GET','/audit-log')).json.entries.some((e:{action:string})=>e.action.startsWith('payroll.'))).toBe(false);
  expect((await auditor.client.req('GET','/audit-log/facets')).json.actions.some((a:string)=>a.startsWith('payroll.'))).toBe(false);
 });
 it('keeps pre-migration allowances unclassified through reopen and edits',async()=>{
  const owner=await h.user('payroll-legacy');const co=await h.company('payroll-legacy',owner.id);await owner.client.login();
  const employee=(await owner.client.req('POST','/employees',{employee_number:'LEG1',display_name:'Legacy employee',employment_start:'2025-01-01',employment_end:null})).json;
  const draft=(await owner.client.req('POST','/payroll/drafts',{month:'2026-04-01'})).json.draft;
  await h.q('INSERT INTO payroll_draft_employees(company_id,draft_id,employee_id,salary,allowances,bonus,overtime,deductions,employer_contributions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[co,draft.id,employee.id,'1000.01','123.45','0.01','0.00','0.02','0.03']);
  const path=`/payroll/drafts/${draft.id}/employees/${employee.id}`;
  const before=(await owner.client.req('GET','/payroll/drafts?month=2026-04-01')).json;
  expect(before.draft).toMatchObject({gross_earnings:'1123.47',net_payable:'1123.45'});
  expect(before.employees[0]).toMatchObject({allowances:'123.45',legacy_allowances:'123.45',housing_allowance:'0.00',transportation_allowance:'0.00',other_allowance:'0.00'});
  const saved=await owner.client.req('PUT',path,{...values(1,'1000.01'),housing_allowance:'0.01',transportation_allowance:'0.02',other_allowance:'0.03',bonus:'0.01',overtime:'0.00',deductions:'0.02',employer_contributions:'0.03'});
  expect(saved.status).toBe(200);
  expect(saved.json.employees[0]).toMatchObject({allowances:'123.51',legacy_allowances:'123.45',housing_allowance:'0.01',transportation_allowance:'0.02',other_allowance:'0.03'});
  expect(saved.json.draft).toMatchObject({gross_earnings:'1123.53',net_payable:'1123.51'});
  const reopened=(await owner.client.req('GET','/payroll/drafts?month=2026-04-01')).json;
  expect(reopened.draft).toMatchObject({gross_earnings:'1123.53',net_payable:'1123.51'});
  expect(reopened.employees[0].legacy_allowances).toBe('123.45');
  const stored=await h.q<{legacy_allowances:string}>("SELECT legacy_allowances::text FROM payroll_draft_employees WHERE draft_id=$1 AND employee_id=$2",[draft.id,employee.id]);
  expect(stored[0]?.legacy_allowances).toBe('123.45');
 });
});
