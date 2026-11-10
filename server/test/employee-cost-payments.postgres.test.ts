import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/http-pg';

const describeDatabase=process.env['DATABASE_URL']?describe:describe.skip;
type Harness=Awaited<ReturnType<typeof startHarness>>;
const costBody=(fy:string,amount='100.00')=>({category:'salary',nature:'earning',currency_code:'SAR',total_amount:amount,service_period_start:'2026-01-01',service_period_end:'2026-01-31',description:'Salary cost',allocations:[{fiscal_year_id:fy,allocation_month:'2026-01-01',amount}]});

describeDatabase('ECC-02 employee cost payment reconciliation (PostgreSQL)',()=>{
  let h:Harness;let seq=0;
  beforeAll(async()=>{h=await startHarness();});afterAll(()=>h.close());
  async function setup(label:string){
    const owner=await h.user(`${label}-owner`),viewer=await h.user(`${label}-viewer`),limited=await h.user(`${label}-limited`),company=await h.company(`${label}-${++seq}`,owner.id);
    await h.member(company,viewer.id,['employee.view','employee_cost.view','employee_cost.payment.view','employee_cost.payment.allocate','bank.view','audit.view']);
    await h.member(company,limited.id,['employee.view','employee_cost.view','employee_cost.payment.view','employee_cost.payment.allocate','employee_cost.payment.reverse']);
    for(const user of [owner,viewer,limited])await user.client.login();
    const fy=await h.fiscalYear(company,'FY26','2026-01-01','2026-12-31');
    const employee=(await owner.client.req('POST','/employees',{employee_number:`E${seq}`,display_name:`Employee ${seq}`,employment_start:'2025-01-01',employment_end:null})).json;
    const draft=await owner.client.req('POST','/employee-costs',{employee_id:employee.id,record:costBody(fy)});
    expect(draft.status).toBe(201);
    expect((await owner.client.req('POST',`/employee-costs/${draft.json.record.id}/approve`,{version:1})).status).toBe(200);
    const bank=(await h.q<{id:string}>("INSERT INTO bank_accounts(company_id,display_name,currency_code,created_by) VALUES($1,'Main','SAR',$2) RETURNING id",[company,owner.id]))[0]!.id;
    async function tx(amount:string,date='2026-01-20'){
      return (await h.q<{id:string}>("INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,created_by_user_id) VALUES($1,$2,$3,$4,'SAR','Payment test',$5,$6,'strong','manual',$7,$8) RETURNING id",[company,bank,date,amount,`ref-${randomUUID()}`,randomUUID().replaceAll('-',''),'other',owner.id]))[0]!.id;
    }
    const costId=draft.json.record.id,costAllocationId=(await h.q<{id:string}>('SELECT id FROM employee_cost_allocations WHERE cost_record_id=$1',[costId]))[0]!.id;
    return{owner,viewer,limited,company,fy,employee,costId,costAllocationId,bank,tx};
  }
  it('supports partial and multi-employee allocations while serializing capacity across concurrent payments',async()=>{
    const x=await setup('ecc-pay-partial');
    const second=(await x.owner.client.req('POST','/employees',{employee_number:'E2',display_name:'Employee Two',employment_start:'2025-01-01',employment_end:null})).json;
    const d=await x.owner.client.req('POST','/employee-costs',{employee_id:second.id,record:costBody(x.fy,'100.00')});
    expect(d.status,JSON.stringify(d.json)).toBe(201);expect((await x.owner.client.req('POST',`/employee-costs/${d.json.record.id}/approve`,{version:1})).status).toBe(200);
    const bank=await x.tx('-100.00');
    const pay=(id:string,alloc:string,amount:string)=>x.owner.client.req('POST',`/employee-costs/${id}/payments`,{cost_allocation_id:alloc,bank_transaction_id:bank,amount,beneficiary_type:'employee',counterparty_id:null});
    expect((await pay(x.costId,x.costAllocationId,'40.00')).status).toBe(201);
    const secondAllocation=(await h.q<{id:string}>('SELECT id FROM employee_cost_allocations WHERE cost_record_id=$1',[d.json.record.id]))[0]!.id;
    expect((await pay(d.json.record.id,secondAllocation,'60.00')).status).toBe(201);
    expect((await pay(x.costId,x.costAllocationId,'1.00')).status).toBe(409);
    const report=await x.owner.client.req('GET',`/employee-costs/reconciliation/monthly?fiscal_year_id=${x.fy}&month=2026-01-01`);
    expect(report.json.rows).toHaveLength(2);expect(report.json.rows.find((r:{employee_id:string})=>r.employee_id===x.employee.id)).toMatchObject({recorded_cost:'100.00',verified_paid:'40.00',outstanding:'60.00'});
    const tx1=await x.tx('-70.00'),tx2=await x.tx('-70.00');
    const concurrent=await Promise.all([tx1,tx2].map(id=>x.owner.client.req('POST',`/employee-costs/${x.costId}/payments`,{cost_allocation_id:x.costAllocationId,bank_transaction_id:id,amount:'40.00',beneficiary_type:'employee',counterparty_id:null})));
    expect(concurrent.map(r=>r.status).sort()).toEqual([201,409]);
    const employer=await x.owner.client.req('POST','/employee-costs',{employee_id:x.employee.id,record:{...costBody(x.fy,'25.00'),category:'employer_gosi',nature:'employer_cost'}});
    expect(employer.status).toBe(201);expect((await x.owner.client.req('POST',`/employee-costs/${employer.json.record.id}/approve`,{version:1})).status).toBe(200);
    const employerAllocation=(await h.q<{id:string}>('SELECT id FROM employee_cost_allocations WHERE cost_record_id=$1',[employer.json.record.id]))[0]!.id;
    const party=(await h.q<{id:string}>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Insurance Provider','supplier',$2) RETURNING id",[x.company,x.owner.id]))[0]!.id;
    const thirdPartyBank=await x.tx('-25.00');
    expect((await x.owner.client.req('POST',`/employee-costs/${employer.json.record.id}/payments`,{cost_allocation_id:employerAllocation,bank_transaction_id:thirdPartyBank,amount:'25.00',beneficiary_type:'counterparty',counterparty_id:party})).status).toBe(201);
  });
  it('shares capacity with document settlement and blocks corrections until payments are reversed',async()=>{
    const x=await setup('ecc-pay-cross');const bank=await x.tx('-100.00');
    const doc=(await h.q<{id:string}>("INSERT INTO documents(company_id,uploaded_by_user_id,original_filename,mime_type,size_bytes,storage_key,sha256,status,document_type,document_date,total_amount) VALUES($1,$2,'i.pdf','application/pdf',4,$3,$4,'approved','purchase','2026-01-02','60.00') RETURNING id",[x.company,x.owner.id,randomUUID(),'a'.repeat(64)]))[0]!.id;
    await h.q("INSERT INTO bank_transaction_matches(company_id,document_id,bank_transaction_id,matched_by_user_id,match_type) VALUES($1,$2,$3,$4,'document')",[x.company,doc,bank,x.owner.id]);
    await h.q("INSERT INTO document_settlements(company_id,document_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,60,$4)",[x.company,doc,bank,x.owner.id]);
    const request={cost_allocation_id:x.costAllocationId,bank_transaction_id:bank,amount:'100.00',beneficiary_type:'employee',counterparty_id:null};
    expect((await x.owner.client.req('POST',`/employee-costs/${x.costId}/payments`,request)).status).toBe(409);
    const clean=await x.tx('-100.00');request.bank_transaction_id=clean;
    expect((await x.owner.client.req('POST',`/employee-costs/${x.costId}/payments`,request)).status).toBe(201);
    const paidCorrection=await x.owner.client.req('POST',`/employee-costs/${x.costId}/corrections`,{reason:'Correct cost',record:costBody(x.fy,'110.00')});
    expect(paidCorrection.status).toBe(409);expect(paidCorrection.json.code).toBe('EMPLOYEE_COST_PAYMENT_ACTIVE');
    expect(await h.count('SELECT COUNT(*)::text n FROM employee_cost_records WHERE company_id=$1 AND supersedes_id=$2',[x.company,x.costId])).toBe(0);
    const refund=await x.tx('20.00','2026-02-01');
    expect((await x.owner.client.req('POST',`/employee-cost-payments/${(await h.q<{id:string}>("SELECT id FROM employee_cost_payment_allocations WHERE bank_transaction_id=$1 AND allocation_type='payment'",[clean]))[0]!.id}/reversals`,{bank_transaction_id:refund,amount:'20.00',reason:'Bank refund'})).status).toBe(201);
    const badRefund=await x.tx('-20.00','2026-02-02');
    const paymentId=(await h.q<{id:string}>("SELECT id FROM employee_cost_payment_allocations WHERE bank_transaction_id=$1 AND allocation_type='payment'",[clean]))[0]!.id;
    expect((await x.owner.client.req('POST',`/employee-cost-payments/${paymentId}/reversals`,{bank_transaction_id:badRefund,amount:'1.00',reason:'Wrong direction'})).status).toBe(409);
    const full=await x.tx('80.00','2026-02-03');
    expect((await x.owner.client.req('POST',`/employee-cost-payments/${paymentId}/reversals`,{bank_transaction_id:full,amount:'80.00',reason:'Reverse remainder'})).status).toBe(201);
    const correction=await x.owner.client.req('POST',`/employee-costs/${x.costId}/corrections`,{reason:'Correct cost',record:costBody(x.fy,'110.00')});
    expect(correction.status).toBe(201);
    const replacementId=correction.json.record.id,replacementAllocation=(await h.q<{id:string}>('SELECT id FROM employee_cost_allocations WHERE cost_record_id=$1',[replacementId]))[0]!.id;
    const replacementBank=await x.tx('-110.00','2026-03-01');
    expect((await x.owner.client.req('POST',`/employee-costs/${replacementId}/payments`,{cost_allocation_id:replacementAllocation,bank_transaction_id:replacementBank,amount:'110.00',beneficiary_type:'employee',counterparty_id:null})).status).toBe(201);
    const supersededBank=await x.tx('-1.00','2026-03-02');
    expect((await x.owner.client.req('POST',`/employee-costs/${x.costId}/payments`,{cost_allocation_id:x.costAllocationId,bank_transaction_id:supersededBank,amount:'1.00',beneficiary_type:'employee',counterparty_id:null})).status).toBe(409);
    await expect(h.q("INSERT INTO employee_cost_payment_allocations(company_id,bank_transaction_id,cost_record_id,cost_allocation_id,allocation_type,beneficiary_type,amount,created_by) VALUES($1,$2,$3,$4,'payment','employee',1,$5)",[x.company,supersededBank,x.costId,x.costAllocationId,x.owner.id])).rejects.toThrow(/active approved cost/i);
  });
  it('enforces tenant and closed-period boundaries and hides salary payments from banking and audit views',async()=>{
    const x=await setup('ecc-pay-private'),y=await setup('ecc-pay-other');
    const bank=await x.tx('-100.00');
    const bad=await x.owner.client.req('POST',`/employee-costs/${x.costId}/payments`,{cost_allocation_id:y.costAllocationId,bank_transaction_id:bank,amount:'10.00',beneficiary_type:'employee',counterparty_id:null});
    expect([400,404]).toContain(bad.status);
    const direct=await x.owner.client.req('POST',`/employee-costs/${x.costId}/payments`,{cost_allocation_id:x.costAllocationId,bank_transaction_id:bank,amount:'10.00',beneficiary_type:'employee',counterparty_id:null});expect(direct.status).toBe(201);
    await h.q("UPDATE fiscal_years SET status='closed' WHERE id=$1",[x.fy]);
    const closed=await x.tx('-10.00','2026-03-01');
    expect((await x.owner.client.req('POST',`/employee-costs/${x.costId}/payments`,{cost_allocation_id:x.costAllocationId,bank_transaction_id:closed,amount:'10.00',beneficiary_type:'employee',counterparty_id:null})).status).toBe(409);
    const audit=await x.viewer.client.req('GET','/audit-log');expect(JSON.stringify(audit.json)).not.toContain('employee_cost_payment');
    const bankView=await x.viewer.client.req('GET','/bank-transactions');expect(JSON.stringify(bankView.json)).not.toContain('employee_cost_payment');
    const paymentOptions=await x.viewer.client.req('GET','/employee-costs/payment-options');expect(paymentOptions.status).toBe(200);expect(paymentOptions.json.bank_transactions.some((t:{id:string})=>t.id===bank)).toBe(false);
    expect((await x.viewer.client.req('GET',`/employee-costs/${x.costId}/payments`)).status).toBe(403);
    expect((await x.limited.client.req('GET','/employee-costs/payment-options')).status).toBe(403);
    expect((await x.limited.client.req('GET',`/employee-costs/${x.costId}/payments`)).status).toBe(403);
    expect((await x.limited.client.req('POST',`/employee-costs/${x.costId}/payments`,{cost_allocation_id:x.costAllocationId,bank_transaction_id:bank,amount:'1.00',beneficiary_type:'employee',counterparty_id:null})).status).toBe(403);
    expect((await x.limited.client.req('POST',`/employee-cost-payments/${randomUUID()}/reversals`,{bank_transaction_id:bank,amount:'1.00',reason:'test'})).status).toBe(403);
  });
  it('excludes obligation and custody explanations from employee-cost payment capacity',async()=>{
    const x=await setup('ecc-pay-exclusive');
    const party=(await h.q<{id:string}>("INSERT INTO counterparties(company_id,name,type,created_by_user_id) VALUES($1,'Supplier','supplier',$2) RETURNING id",[x.company,x.owner.id]))[0]!.id;
    const obligation=(await h.q<{id:string}>("INSERT INTO obligations(company_id,direction,counterparty_id,original_amount,recognized_on,verification_status,source_type,created_by_user_id) VALUES($1,'payable',$2,25,'2026-01-05','confirmed','manual',$3) RETURNING id",[x.company,party,x.owner.id]))[0]!.id;
    const obligationBank=await x.tx('-25.00');
    await h.q("INSERT INTO obligation_settlements(company_id,obligation_id,bank_transaction_id,amount,created_by_user_id) VALUES($1,$2,$3,25,$4)",[x.company,obligation,obligationBank,x.owner.id]);
    const payment=(bank_transaction_id:string)=>x.owner.client.req('POST',`/employee-costs/${x.costId}/payments`,{cost_allocation_id:x.costAllocationId,bank_transaction_id,amount:'1.00',beneficiary_type:'employee',counterparty_id:null});
    expect((await payment(obligationBank)).status).toBe(409);
    const custody=(await h.q<{id:string}>("INSERT INTO custody_advances(company_id,holder_user_id,purpose,created_by_user_id) VALUES($1,$2,'Work advance',$2) RETURNING id",[x.company,x.owner.id]))[0]!.id;
    const custodyBank=await x.tx('-25.00');
    await h.q("INSERT INTO bank_transaction_matches(company_id,document_id,bank_transaction_id,matched_by_user_id,match_type,custody_id) VALUES($1,NULL,$2,$3,'custody_funding',$4)",[x.company,custodyBank,x.owner.id,custody]);
    expect((await payment(custodyBank)).status).toBe(409);
  });
});
