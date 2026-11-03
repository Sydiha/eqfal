import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// This suite writes fixture records. Locally, require an explicit disposable-db flag; CI qualifies only for its exact loopback eqfal_ci service.
const disposableCiDatabase=process.env['CI']==='true'&&process.env['REQUIRE_POSTGRES_TESTS']==='true'&&process.env['DATABASE_URL']==='postgresql://eqfal:eqfal_ci@127.0.0.1:5432/eqfal_ci';
const describeIsolated=(process.env['DATABASE_URL']&&process.env['EQFAL_ISOLATED_TEST_DATABASE']==='1')||disposableCiDatabase?describe:describe.skip;
type Harness=Awaited<ReturnType<typeof startHarness>>;type Owner=Awaited<ReturnType<Harness['user']>>;
describeIsolated('Chart of Accounts import downstream integration (isolated PostgreSQL)',()=>{
 let h:Awaited<ReturnType<typeof startHarness>>;let company:string;let fy:string;let client:Owner['client'];let actor:string;
 beforeAll(async()=>{h=await startHarness();const owner=await h.user('accountImport');actor=owner.id;company=await h.company('accountImport',owner.id);await owner.client.login();client=owner.client;fy=await h.fiscalYear(company,'Import FY','2026-01-01','2026-12-31');});
 afterAll(()=>h.close());
 it('imports shared-model accounts and consumes them in journals, ledger, trial balance, and financial statements',async()=>{
  const imported=await client.req('POST','/accounts/import',{rows:[
   {code:'IMP-CASH',name_ar:'نقد مستورد',name_en:'Imported cash',account_type:'asset',parent_code:'IMP-ASSETS',statement_category:'current_asset',is_contra:false,cash_role:'cash',cash_flow_category:'operating'},
   {code:'IMP-REV',name_ar:'إيراد مستورد',name_en:'Imported revenue',account_type:'revenue',parent_code:null,statement_category:'revenue',is_contra:false,cash_role:'non_cash',cash_flow_category:'operating'},
   {code:'IMP-ASSETS',name_ar:'الأصول المستوردة',name_en:'Imported assets',account_type:'asset',parent_code:null,statement_category:'current_asset',is_contra:false,cash_role:'non_cash',cash_flow_category:'unmapped'},
  ]});expect(imported.status,JSON.stringify(imported.json)).toBe(200);expect(imported.json.imported).toBe(3);
  const accounts=(await client.req('GET','/accounts')).json.accounts as Array<{id:string;code:string;parent_account_id:string|null}>;const cash=accounts.find(a=>a.code==='IMP-CASH')!,rev=accounts.find(a=>a.code==='IMP-REV')!,parent=accounts.find(a=>a.code==='IMP-ASSETS')!;expect(cash.parent_account_id).toBe(parent.id);
  const journal=await client.req('POST','/journals',{fiscal_year_id:fy,accounting_date:'2026-02-01',description:'Imported account integration',reference:null,source_type:null,source_id:null,entry_type:'standard'});expect(journal.status,JSON.stringify(journal.json)).toBe(201);
  expect((await client.req('PUT',`/journals/${journal.json.id}/lines`,{lines:[{account_id:cash.id,debit:'100.00',credit:'0.00',memo:null},{account_id:rev.id,debit:'0.00',credit:'100.00',memo:null}]})).status).toBe(200);
  expect((await client.req('POST',`/journals/${journal.json.id}/post`,{})).status).toBe(200);
  const q=`fiscal_year_id=${fy}`;const tb=await client.req('GET',`/trial-balance?${q}`);expect(tb.status).toBe(200);expect(tb.json.accounts).toEqual(expect.arrayContaining([expect.objectContaining({account_id:cash.id,debit_balance:'100.00'}),expect.objectContaining({account_id:rev.id,credit_balance:'100.00'})]));
  const gl=await client.req('GET',`/general-ledger?account_id=${cash.id}&${q}`);expect(gl.status).toBe(200);expect(gl.json.activity).toHaveLength(1);expect(gl.json.activity[0].debit).toBe('100.00');
  const fp=await client.req('GET',`/financial-statements/financial-position?${q}`);expect(fp.status,JSON.stringify(fp.json)).toBe(200);expect(fp.json.sections.flatMap((s:any)=>s.accounts)).toEqual(expect.arrayContaining([expect.objectContaining({account_id:cash.id,amount:'100.00'})]));
  const pl=await client.req('GET',`/financial-statements/profit-or-loss?${q}`);expect(pl.status,JSON.stringify(pl.json)).toBe(200);expect(pl.json.sections.flatMap((s:any)=>s.accounts)).toEqual(expect.arrayContaining([expect.objectContaining({account_id:rev.id,amount:'100.00'})]));
 });
 it('rejects code conflicts and malformed hierarchy without changing existing or imported rows',async()=>{
  const before=await h.count('SELECT COUNT(*)::text n FROM accounts WHERE company_id=$1',[company]);const bad=await client.req('POST','/accounts/import',{rows:[{code:'IMP-REV',name_en:'collision',account_type:'revenue',parent_code:null,statement_category:'revenue'},{code:'X',name_en:'x',account_type:'asset',parent_code:'Y',statement_category:'current_asset'},{code:'Y',name_en:'y',account_type:'asset',parent_code:'X',statement_category:'current_asset'}]});expect(bad.status).toBe(400);expect(bad.json.issues.length).toBeGreaterThanOrEqual(3);expect(await h.count('SELECT COUNT(*)::text n FROM accounts WHERE company_id=$1',[company])).toBe(before);expect(await h.count("SELECT COUNT(*)::text n FROM accounts WHERE company_id=$1 AND code='IMP-REV'",[company])).toBe(1);
 });
});
