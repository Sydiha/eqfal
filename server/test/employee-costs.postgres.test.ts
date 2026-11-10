import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

// Focused ECC-01 negative and concurrency checks over real HTTP + PostgreSQL. Uses a disposable DATABASE_URL.
const describeDatabase=process.env['DATABASE_URL']?describe:describe.skip;
type Harness=Awaited<ReturnType<typeof startHarness>>;
type CostBody={category:string;nature:string;currency_code:string;total_amount:string;service_period_start:string;service_period_end:string;description:string;allocations:Array<{fiscal_year_id:string;allocation_month:string;amount:string}>};

describeDatabase('ECC-01 employee costs (PostgreSQL)',()=>{
  let h:Harness;
  beforeAll(async()=>{h=await startHarness();});
  afterAll(()=>h.close());
  let n=0;
  const cost=(fy:string, amount='100.00', category='salary', nature='earning'):CostBody=>({category,nature,currency_code:'SAR',total_amount:amount,service_period_start:'2026-01-01',service_period_end:'2026-01-31',description:'January recorded cost',allocations:[{fiscal_year_id:fy,allocation_month:'2026-01-01',amount}]});
  async function setup(label:string){
    const owner=await h.user(`${label}-owner`),view=await h.user(`${label}-view`),company=await h.company(`${label}-${++n}`,owner.id);
    await h.member(company,view.id,['employee.view','employee_cost.view','employee_cost.create','employee_cost.approve','employee_cost.correct']);
    for(const u of [owner,view])await u.client.login();
    const fy=await h.fiscalYear(company,'FY26','2026-01-01','2026-12-31');
    const employee=(await owner.client.req('POST','/employees',{employee_number:`E-${n}`,display_name:`Employee ${n}`,employment_start:'2025-01-01',employment_end:null}));
    expect(employee.status).toBe(201);
    return{owner,view,company,fy,employee:employee.json as {id:string}};
  }

  it('denies salary and deduction details to users without the dedicated salary capability',async()=>{
    const x=await setup('ecc-salary');
    const draft=await x.owner.client.req('POST','/employee-costs',{employee_id:x.employee.id,record:cost(x.fy)});
    expect(draft.status).toBe(201);
    expect((await x.view.client.req('POST','/employee-costs',{employee_id:x.employee.id,record:cost(x.fy,'50.00')})).status).toBe(403);
    expect((await x.view.client.req('POST',`/employee-costs/${draft.json.record.id}/approve`,{version:1})).status).toBe(403);
    expect((await x.owner.client.req('POST',`/employee-costs/${draft.json.record.id}/approve`,{version:1})).status).toBe(200);
    const report=await x.view.client.req('GET',`/employee-costs/reports/annual?fiscal_year_id=${x.fy}`);
    expect(report.status).toBe(200);expect(report.json.rows).toEqual([]);expect(report.json.salary_details_included).toBe(false);
    expect((await x.view.client.req('GET',`/employee-costs/${draft.json.record.id}/history`)).status).toBe(403);
  });

  it('denies unauthorized edits and corrections when the locked original is sensitive, even with an employer-cost replacement',async()=>{
    const x=await setup('ecc-original-salary');
    const employerCost={...cost(x.fy,'100.00','employer_gosi','employer_cost'),description:'Employer GOSI'};
    const draft=await x.owner.client.req('POST','/employee-costs',{employee_id:x.employee.id,record:cost(x.fy)});
    expect(draft.status).toBe(201);
    const update=await x.view.client.req('PATCH',`/employee-costs/${draft.json.record.id}`,{version:1,record:employerCost});
    expect(update.status).toBe(403);
    expect(await h.count("SELECT COUNT(*)::text n FROM employee_cost_records WHERE id=$1 AND nature='earning' AND status='draft'",[draft.json.record.id])).toBe(1);
    expect((await x.owner.client.req('POST',`/employee-costs/${draft.json.record.id}/approve`,{version:1})).status).toBe(200);
    const correction=await x.view.client.req('POST',`/employee-costs/${draft.json.record.id}/corrections`,{reason:'Reclassify salary',record:employerCost});
    expect(correction.status).toBe(403);
    expect(await h.count('SELECT COUNT(*)::text n FROM employee_cost_records WHERE company_id=$1 AND supersedes_id=$2',[x.company,draft.json.record.id])).toBe(0);
  });

  it('rejects employee and fiscal-year IDs from another tenant',async()=>{
    const a=await setup('ecc-tenant-a'),b=await setup('ecc-tenant-b');
    const employeeRef=await a.owner.client.req('POST','/employee-costs',{employee_id:b.employee.id,record:cost(a.fy)});
    expect(employeeRef.status).toBe(404);
    const fiscalYearRef=await a.owner.client.req('POST','/employee-costs',{employee_id:a.employee.id,record:cost(b.fy)});
    expect([400,404]).toContain(fiscalYearRef.status);
    expect(await h.count('SELECT COUNT(*)::text n FROM employee_cost_records WHERE company_id=$1',[a.company])).toBe(0);
  });

  it('rejects duplicate employee/month allocations before recording a draft',async()=>{
    const x=await setup('ecc-duplicate'),record=cost(x.fy);
    const nextFy=await h.fiscalYear(x.company,'FY27','2027-01-01','2027-12-31');
    record.allocations=[...record.allocations,{...record.allocations[0]!,fiscal_year_id:nextFy,amount:'1.00'}];record.total_amount='101.00';
    const result=await x.owner.client.req('POST','/employee-costs',{employee_id:x.employee.id,record});
    expect(result.status).toBe(400);
    expect(await h.count('SELECT COUNT(*)::text n FROM employee_cost_records WHERE company_id=$1',[x.company])).toBe(0);
  });

  it('serializes concurrent approvals and corrections for the same record',async()=>{
    const x=await setup('ecc-concurrent-correction');
    const draft=await x.owner.client.req('POST','/employee-costs',{employee_id:x.employee.id,record:cost(x.fy)});
    const approvals=await Promise.all([1,2].map(()=>x.owner.client.req('POST',`/employee-costs/${draft.json.record.id}/approve`,{version:1})));
    expect(approvals.map(r=>r.status).sort()).toEqual([200,409]);
    const changes=await Promise.all([1,2].map(()=>x.owner.client.req('POST',`/employee-costs/${draft.json.record.id}/corrections`,{reason:'Concurrent correction',record:cost(x.fy,'125.00')})));
    expect(changes.map(r=>r.status).sort()).toEqual([201,409]);
    const report=await x.owner.client.req('GET',`/employee-costs/reports/annual?fiscal_year_id=${x.fy}`);
    expect(report.status).toBe(200);expect(report.json.rows).toHaveLength(1);expect(report.json.rows[0].amount).toBe('125.00');
  });

  it('supports sequential corrections across fiscal years and reports only the final replacement once',async()=>{
    const x=await setup('ecc-correction');
    const nextFy=await h.fiscalYear(x.company,'FY27','2027-01-01','2027-12-31');
    const spanningCost=(fy:string,month:string,amount:string):CostBody=>({category:'salary',nature:'earning',currency_code:'SAR',total_amount:amount,service_period_start:'2026-12-01',service_period_end:'2027-01-31',description:'Corrected service-period cost',allocations:[{fiscal_year_id:fy,allocation_month:month,amount}]});
    const draft=await x.owner.client.req('POST','/employee-costs',{employee_id:x.employee.id,record:spanningCost(x.fy,'2026-12-01','100.00')});
    expect(draft.status).toBe(201);
    expect((await x.owner.client.req('POST',`/employee-costs/${draft.json.record.id}/approve`,{version:1})).status).toBe(200);
    expect((await x.owner.client.req('GET',`/employee-costs/reports/annual?fiscal_year_id=${x.fy}`)).json.rows[0].amount).toBe('100.00');
    const first=await x.owner.client.req('POST',`/employee-costs/${draft.json.record.id}/corrections`,{reason:'Move allocation to FY27',record:spanningCost(nextFy,'2027-01-01','125.00')});
    expect(first.status).toBe(201);
    const second=await x.owner.client.req('POST',`/employee-costs/${first.json.record.id}/corrections`,{reason:'Correct replacement amount',record:spanningCost(nextFy,'2027-01-01','150.00')});
    expect(second.status).toBe(201);
    const history=await x.owner.client.req('GET',`/employee-costs/${draft.json.record.id}/history`);
    expect(history.status).toBe(200);expect(history.json.history).toHaveLength(3);
    expect(history.json.history.find((row:{supersedes_id:string|null})=>row.supersedes_id===draft.json.record.id)).toMatchObject({total_amount:'125.00',correction_reason:'Move allocation to FY27'});
    const oldYear=await x.owner.client.req('GET',`/employee-costs/reports/annual?fiscal_year_id=${x.fy}`);
    expect(oldYear.status).toBe(200);expect(oldYear.json.rows).toEqual([]);
    const newYear=await x.owner.client.req('GET',`/employee-costs/reports/annual?fiscal_year_id=${nextFy}`);
    expect(newYear.status).toBe(200);expect(newYear.json.rows).toHaveLength(1);expect(newYear.json.rows[0].amount).toBe('150.00');
    expect(await h.count("SELECT COUNT(*)::text n FROM audit_log WHERE company_id=$1 AND action IN ('employee_cost.corrected','employee_cost.correction_approve')",[x.company])).toBe(4);
  });
});
