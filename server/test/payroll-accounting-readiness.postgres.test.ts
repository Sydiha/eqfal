import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

const describeDatabase = process.env['DATABASE_URL'] ? describe : describe.skip;
type Harness = Awaited<ReturnType<typeof startHarness>>;
const values = { version: 0, salary: '100.10', housing_allowance: '0.10', transportation_allowance: '0.05', other_allowance: '0.05', bonus: '0.30', overtime: '0.40', deductions: '0.50', employer_contributions: '0.60' };
const keys = ['earnings_expense','employer_contribution_expense','net_payroll_liability','employee_deduction_liability','employer_contribution_liability'];

describeDatabase('PAYROLL-02 accounting readiness (PostgreSQL)', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(() => h.close());

  it('validates explicit account mappings, blocks overlap, warns on manual journals, and never changes reports or ledger', async () => {
    const owner = await h.user('pr2-owner'), editor = await h.user('pr2-editor'), approver = await h.user('pr2-approver'), viewOnly = await h.user('pr2-view'), outsider = await h.user('pr2-outsider');
    const co = await h.company('pr2-main', owner.id), other = await h.company('pr2-other', outsider.id);
    await h.member(co, editor.id, ['payroll.view','payroll.edit','payroll.accounting.mapping.view','payroll.accounting.mapping.manage','payroll.accounting.preview','accounting.view','employee.view','employee_cost.view','employee_cost.salary.view']);
    await h.member(co, approver.id, ['payroll.view','payroll.approve']);
    await h.member(co, viewOnly.id, ['payroll.view','payroll.accounting.preview']);
    for (const u of [owner, editor, approver, viewOnly, outsider]) await u.client.login();
    const fullRole = (await h.q<{ id: string }>('SELECT role_id AS id FROM memberships WHERE company_id=$1 AND user_id=$2',[co,owner.id]))[0]!.id;
    expect((await owner.client.req('GET','/payroll/account-mappings')).status).toBe(403);
    for (const cap of ['payroll.accounting.mapping.view','payroll.accounting.mapping.manage','payroll.accounting.preview']) {
      const denied = await owner.client.req('PUT',`/access/roles/${fullRole}/capabilities/${cap}`);
      expect(denied.status).toBe(403);
      expect(denied.json.code).toBe('ACCESS_FULL_ACCESS_IMMUTABLE');
    }
    expect((await owner.client.req('GET','/payroll/account-mappings')).status).toBe(403);

    const delegatedAdmin = await h.user('pr2-delegated-admin');
    await h.member(co,delegatedAdmin.id,['payroll.view','access.role.create','access.role.capability.grant','access.full_access.grant']);
    await delegatedAdmin.client.login();
    const restrictedRole = await delegatedAdmin.client.req('POST','/access/roles',{name:'Payroll accounting restricted'});
    expect(restrictedRole.status).toBe(201);
    for (const cap of ['payroll.accounting.mapping.view','payroll.accounting.mapping.manage','payroll.accounting.preview']) {
      const denied = await delegatedAdmin.client.req('PUT',`/access/roles/${restrictedRole.json.id}/capabilities/${cap}`);
      expect(denied.status).toBe(403);
      expect(denied.json.code).toBe('ACCESS_ROLE_CEILING');
    }
    const delegatedViewer = await h.user('pr2-capability-granter');
    await h.member(co,delegatedViewer.id,['payroll.view','access.role.create','access.role.capability.grant','payroll.accounting.mapping.view']);
    await delegatedViewer.client.login();
    const viewRole = await delegatedViewer.client.req('POST','/access/roles',{name:'Payroll mapping viewer'});
    expect(viewRole.status).toBe(201);
    expect((await delegatedViewer.client.req('PUT',`/access/roles/${viewRole.json.id}/capabilities/payroll.accounting.mapping.view`)).status).toBe(204);
    const noManage = await delegatedViewer.client.req('PUT',`/access/roles/${viewRole.json.id}/capabilities/payroll.accounting.mapping.manage`);
    expect(noManage.status).toBe(403);
    expect(noManage.json.code).toBe('ACCESS_ROLE_CEILING');
    const delegatedManager = await h.user('pr2-capability-manager');
    await h.member(co,delegatedManager.id,['payroll.view','access.role.create','access.role.capability.grant','payroll.accounting.mapping.manage']);
    await delegatedManager.client.login();
    const manageRole = await delegatedManager.client.req('POST','/access/roles',{name:'Payroll mapping manager'});
    expect(manageRole.status).toBe(201);
    expect((await delegatedManager.client.req('PUT',`/access/roles/${manageRole.json.id}/capabilities/payroll.accounting.mapping.manage`)).status).toBe(204);

    const employee = (await owner.client.req('POST','/employees',{employee_number:'PR2-1',display_name:'Payroll readiness employee',employment_start:'2025-01-01',employment_end:null})).json;
    const fy = await h.fiscalYear(co,'FY26','2026-01-01','2026-12-31');
    const accountIds = [
      await h.account(co,'PR2-EARN','expense','operating_expense'), await h.account(co,'PR2-ER-EXP','expense','operating_expense'),
      await h.account(co,'PR2-NET','liability','current_liability'), await h.account(co,'PR2-DED','liability','current_liability'),
      await h.account(co,'PR2-ER-LIAB','liability','current_liability'),
    ];
    const wrongType = await h.account(co,'PR2-WRONG','liability','current_liability');
    const inactive = await h.account(co,'PR2-INACTIVE','expense','operating_expense');
    await h.q('UPDATE accounts SET is_active=FALSE WHERE id=$1',[inactive]);
    const foreignAccount = await h.account(other,'PR2-FOREIGN','expense','operating_expense');
    expect((await viewOnly.client.req('GET','/payroll/account-mappings')).status).toBe(403);
    expect((await viewOnly.client.req('GET','/payroll/drafts/00000000-0000-4000-8000-000000000001/accounting-preview')).status).toBe(403);
    expect((await editor.client.req('PUT','/payroll/account-mappings/earnings_expense',{account_id:wrongType})).json.code).toBe('PAYROLL_MAPPING_ACCOUNT_TYPE');
    expect((await editor.client.req('PUT','/payroll/account-mappings/earnings_expense',{account_id:inactive})).json.code).toBe('PAYROLL_MAPPING_ACCOUNT_INACTIVE');
    expect((await editor.client.req('PUT','/payroll/account-mappings/earnings_expense',{account_id:foreignAccount})).json.code).toBe('PAYROLL_MAPPING_ACCOUNT_NOT_FOUND');
    const mappingActor = await h.user('pr2-mapping-only');
    await h.member(co,mappingActor.id,['payroll.view','payroll.accounting.mapping.view']); await mappingActor.client.login();
    expect((await mappingActor.client.req('PUT','/payroll/account-mappings/earnings_expense',{account_id:accountIds[0]})).status).toBe(403);

    const draft = (await editor.client.req('POST','/payroll/drafts',{month:'2026-03-01'})).json.draft;
    expect((await editor.client.req('PUT',`/payroll/drafts/${draft.id}/employees/${employee.id}`,values)).status).toBe(200);
    const draftPreview = (await editor.client.req('GET',`/payroll/drafts/${draft.id}/accounting-preview`)).json;
    expect(draftPreview.blockers).toContainEqual(expect.objectContaining({code:'payroll_not_approved'}));
    expect(draftPreview.blockers.filter((x:{code:string})=>x.code==='mapping_missing')).toHaveLength(5);
    for (const [index,key] of keys.entries()) {
      const saved = await editor.client.req('PUT',`/payroll/account-mappings/${key}`,{account_id:accountIds[index]});
      expect(saved.status,JSON.stringify(saved.json)).toBe(200);
    }
    expect(await h.count('SELECT COUNT(*)::text n FROM payroll_account_mappings WHERE company_id=$1',[co])).toBe(5);
    expect((await h.q<{implicit_full_access:boolean}>("SELECT implicit_full_access FROM capabilities WHERE id='payroll.accounting.preview'"))[0]!.implicit_full_access).toBe(false);

    const approved = await approver.client.req('POST',`/payroll/drafts/${draft.id}/approve`,{version:2});
    expect(approved.status,JSON.stringify(approved.json)).toBe(200);
    const febCost = (await h.q<{id:string}>(
      `INSERT INTO employee_cost_records(company_id,employee_id,category,nature,currency_code,total_amount,service_period_start,service_period_end,description,created_by)
       VALUES($1,$2,'salary','earning','SAR','50.00','2026-02-01','2026-02-28','Non-overlapping ECC salary',$3) RETURNING id`,[co,employee.id,owner.id]))[0]!.id;
    await h.q('INSERT INTO employee_cost_allocations(company_id,cost_record_id,fiscal_year_id,allocation_month,amount) VALUES($1,$2,$3,$4,$5)',[co,febCost,fy,'2026-02-01','50.00']);
    await h.q("UPDATE employee_cost_records SET status='approved',approved_by=$2,approved_at=NOW() WHERE id=$1",[febCost,owner.id]);
    const clearPreview = (await editor.client.req('GET',`/payroll/drafts/${draft.id}/accounting-preview`)).json;
    expect(clearPreview.can_preview).toBe(true);
    expect(clearPreview.blockers).toEqual([]);

    const deductionCost = (await h.q<{id:string}>(
      `INSERT INTO employee_cost_records(company_id,employee_id,category,nature,currency_code,total_amount,service_period_start,service_period_end,description,created_by)
       VALUES($1,$2,'employee_deduction','employee_deduction','SAR','0.50','2026-03-01','2026-03-31','Existing ECC deduction',$3) RETURNING id`,[co,employee.id,owner.id]))[0]!.id;
    await h.q('INSERT INTO employee_cost_allocations(company_id,cost_record_id,fiscal_year_id,allocation_month,amount) VALUES($1,$2,$3,$4,$5)',[co,deductionCost,fy,'2026-03-01','0.50']);
    await h.q("UPDATE employee_cost_records SET status='approved',approved_by=$2,approved_at=NOW() WHERE id=$1",[deductionCost,owner.id]);
    const deductionPreview = (await editor.client.req('GET',`/payroll/drafts/${draft.id}/accounting-preview`)).json;
    expect(deductionPreview.can_preview).toBe(false);
    expect(deductionPreview.blockers).toContainEqual(expect.objectContaining({code:'ecc_employee_deduction_overlap',count:1,details:[expect.objectContaining({employee_number:'PR2-1',category:'employee_deduction',amount:'0.50'})]}));

    const manualId = await h.postedJournal(co,fy,'2026-03-20',owner.id,[[accountIds[0]!, '1.00','0.00'],[accountIds[2]!, '0.00','1.00']]);
    const manualOnlyPreview = (await editor.client.req('GET',`/payroll/drafts/${draft.id}/accounting-preview`)).json;
    expect(manualOnlyPreview.can_preview).toBe(false);
    expect(manualOnlyPreview.blockers).toContainEqual(expect.objectContaining({code:'ecc_employee_deduction_overlap',count:1}));
    expect(manualOnlyPreview.warnings).toContainEqual({code:'manual_journal_review',count:1});

    const overlapId = (await h.q<{id:string}>(
      `INSERT INTO employee_cost_records(company_id,employee_id,category,nature,currency_code,total_amount,service_period_start,service_period_end,description,created_by)
       VALUES($1,$2,'salary','earning','SAR','100.00','2026-03-01','2026-03-31','Existing ECC salary',$3) RETURNING id`,[co,employee.id,owner.id]))[0]!.id;
    await h.q('INSERT INTO employee_cost_allocations(company_id,cost_record_id,fiscal_year_id,allocation_month,amount) VALUES($1,$2,$3,$4,$5)',[co,overlapId,fy,'2026-03-01','100.00']);
    await h.q("UPDATE employee_cost_records SET status='approved',approved_by=$2,approved_at=NOW() WHERE id=$1",[overlapId,owner.id]);

    const journalCount = await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1',[co]);
    const financialBefore = await editor.client.req('GET',`/financial-statements/profit-or-loss?fiscal_year_id=${fy}&start_date=2026-03-01&end_date=2026-03-31`);
    const payrollBefore = (await editor.client.req('GET','/payroll/drafts?month=2026-03-01')).json;
    const eccBefore = await editor.client.req('GET',`/employee-costs/reports/monthly?fiscal_year_id=${fy}&month=2026-03-01`);

    const previewResponse = await editor.client.req('GET',`/payroll/drafts/${draft.id}/accounting-preview`);
    expect(previewResponse.status,JSON.stringify(previewResponse.json)).toBe(200);
    const preview = previewResponse.json;
    expect(preview).toMatchObject({balanced:true,can_preview:false,side_effects:false,authority:'informational_only',posting_revalidation_required:true,totals:{earnings:'101.00',employee_deductions:'0.50',net_payable:'100.50',employer_contributions:'0.60',debit_total:'101.60',credit_total:'101.60'}});
    expect(preview.lines).toHaveLength(5);
    expect(preview.blockers).toContainEqual(expect.objectContaining({code:'ecc_overlap',count:1}));
    expect(preview.blockers).toContainEqual(expect.objectContaining({code:'ecc_employee_deduction_overlap',count:1}));
    expect(preview.warnings).toContainEqual({code:'manual_journal_review',count:1});
    expect(preview.blockers[0].details[0]).toMatchObject({employee_number:'PR2-1',category:'salary',amount:'100.00'});
    expect((await viewOnly.client.req('GET',`/payroll/drafts/${draft.id}/accounting-preview`)).status).toBe(403);
    expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1',[co])).toBe(journalCount);
    expect(await h.count('SELECT COUNT(*)::text n FROM employee_cost_records WHERE company_id=$1 AND id=$2 AND status=\'approved\'',[co,overlapId])).toBe(1);
    expect((await editor.client.req('GET',`/financial-statements/profit-or-loss?fiscal_year_id=${fy}&start_date=2026-03-01&end_date=2026-03-31`)).json).toEqual(financialBefore.json);
    expect((await editor.client.req('GET','/payroll/drafts?month=2026-03-01')).json.draft).toEqual(payrollBefore.draft);
    expect((await editor.client.req('GET',`/employee-costs/reports/monthly?fiscal_year_id=${fy}&month=2026-03-01`)).json).toEqual(eccBefore.json);
    expect(await h.count('SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND id=$2',[co,manualId])).toBe(1);
  });
});
