import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { EmployeeCostError, EmployeeCostService } from '../src/modules/employee-costs/employee-cost.service';

describe('employee cost correction payment guard error',()=>{
  it('maps the active-payment database guard to its distinct API error code',async()=>{
    const ids={company:'11111111-1111-4111-8111-111111111111',employee:'22222222-2222-4222-8222-222222222222',cost:'33333333-3333-4333-8333-333333333333',year:'44444444-4444-4444-8444-444444444444'};
    const approved={id:ids.cost,company_id:ids.company,employee_id:ids.employee,category:'salary',nature:'earning',currency_code:'SAR',total_amount:'100.00',service_period_start:'2026-02-01',service_period_end:'2026-02-28',description:'February salary',status:'approved',version:1,supersedes_id:null,correction_reason:null,created_by:'actor',created_at:'2026-02-01',approved_by:'actor',approved_at:'2026-02-01'};
    const guardError=Object.assign(new Error('active payment guard'),{code:'23514',constraint:'employee_cost_payment_active'});
    const query=vi.fn(async(sql:string)=>{
      if(sql.includes('SELECT *,service_period_start::text'))return{rows:[approved],rowCount:1};
      if(sql.includes('SELECT 1 FROM employee_cost_records'))return{rows:[],rowCount:0};
      if(sql.includes('SELECT 1 FROM employees'))return{rows:[{exists:1}],rowCount:1};
      if(sql.startsWith('INSERT INTO employee_cost_records'))throw guardError;
      return{rows:[],rowCount:0};
    });
    const client={query,release:vi.fn()} as unknown as PoolClient;
    const db={connect:vi.fn().mockResolvedValue(client)} as unknown as Pool;
    const service=new EmployeeCostService(db);

    await expect(service.correctCost(ids.company,'actor',ids.cost,'Correct amount',{category:'salary',nature:'earning',currency_code:'SAR',total_amount:'110.00',service_period_start:'2026-02-01',service_period_end:'2026-02-28',description:'Corrected February salary',allocations:[{fiscal_year_id:ids.year,allocation_month:'2026-02-01',amount:'110.00'}]},true)).rejects.toMatchObject({status:409,code:'EMPLOYEE_COST_PAYMENT_ACTIVE'} satisfies Partial<EmployeeCostError>);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
