import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { AccountingPeriodClosedError, assertAccountingDateWritable } from '../monthly-close/accounting-period.guard';

export class EmployeeCostPaymentError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const invalid = (message='Invalid employee cost payment request') => new EmployeeCostPaymentError(400,'EMPLOYEE_COST_PAYMENT_INVALID',message);
const missing = () => new EmployeeCostPaymentError(404,'EMPLOYEE_COST_PAYMENT_NOT_FOUND','Not found');
const conflict = (message='Employee cost payment conflicts with current financial state') => new EmployeeCostPaymentError(409,'EMPLOYEE_COST_PAYMENT_CONFLICT',message);
const forbidden = () => new EmployeeCostPaymentError(403,'FORBIDDEN','Forbidden');
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const cents=(value:string)=>{const [whole,fraction='']=value.split('.');return BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'));};
const money=(value:bigint)=>`${value/100n}.${String(value%100n).padStart(2,'0')}`;

type CostRow={id:string;employee_id:string;employee_number:string;display_name:string;nature:'earning'|'employer_cost'|'employee_deduction';category:string;currency_code:string;total_amount:string;status:string;service_period_start:string;service_period_end:string;supersedes_id:string|null};
type PaymentRow={id:string;company_id:string;bank_transaction_id:string;cost_record_id:string;cost_allocation_id:string;allocation_type:'payment'|'reversal';beneficiary_type:'employee'|'counterparty';counterparty_id:string|null;reverses_allocation_id:string|null;amount:string;note:string|null;reason:string|null;created_by:string;created_at:string;transaction_date:string;bank_reference:string|null;bank_description:string|null;counterparty_name:string|null};

export class EmployeeCostPaymentService {
  private readonly audit=new AuditLogRepository();
  constructor(private readonly db:Pool){}
  private async tx<T>(fn:(c:PoolClient)=>Promise<T>):Promise<T>{
    const c=await this.db.connect();
    try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
    catch(e){await c.query('ROLLBACK');if(e instanceof AccountingPeriodClosedError)throw new EmployeeCostPaymentError(409,e.code,e.message);const err=e as{code?:string};if(err.code==='23503')throw missing();if(err.code==='23505')throw conflict('This bank transaction or reversal is already allocated');if(err.code==='23514')throw conflict('Payment direction, period, or available balance is invalid');if(err.code==='55000')throw conflict('Payment history is immutable');throw e;}
    finally{c.release();}
  }
  private async cost(c:PoolClient,companyId:string,id:string,lock=false):Promise<CostRow>{
    const row=(await c.query<CostRow>(`SELECT r.id,r.employee_id,e.employee_number,e.display_name,r.nature,r.category,r.currency_code,r.total_amount::text,r.status,r.service_period_start::text,r.service_period_end::text,r.supersedes_id
      FROM employee_cost_records r JOIN employees e ON e.id=r.employee_id AND e.company_id=r.company_id
      WHERE r.id=$1 AND r.company_id=$2${lock?' FOR UPDATE OF r':''}`,[id,companyId])).rows[0];
    if(!row)throw missing();return row;
  }
  private visible(cost:CostRow,salaryVisible:boolean){if(cost.nature!=='employer_cost'&&!salaryVisible)throw forbidden();}

  async options(companyId:string,salaryVisible:boolean){
    const eligible = async (sign:'outflow'|'inflow') => (await this.db.query(`SELECT t.id,t.transaction_date::text,t.amount::text,t.currency_code,t.bank_reference,t.description,
        (SELECT COALESCE(SUM(s.amount),0) FROM document_settlements s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
        +(SELECT COALESCE(SUM(a.amount),0) FROM employee_cost_payment_allocations a WHERE a.company_id=t.company_id AND a.bank_transaction_id=t.id) AS allocated_amount
      FROM bank_transactions t WHERE t.company_id=$1 AND t.amount ${sign==='outflow'?'<':'>'} 0 AND t.reconciliation_status<>'reconciled'
        AND ($2::boolean OR NOT EXISTS(SELECT 1 FROM employee_cost_payment_allocations hidden JOIN employee_cost_records hidden_cost ON hidden_cost.id=hidden.cost_record_id AND hidden_cost.company_id=hidden.company_id WHERE hidden.company_id=t.company_id AND hidden.bank_transaction_id=t.id AND hidden_cost.nature<>'employer_cost'))
        AND (t.source_kind<>'manual' OR t.manual_category IN ('supplier_payment','government_payment','customer_receipt','other'))
        AND NOT EXISTS(SELECT 1 FROM obligation_settlements s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM personal_payment_reimbursements s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM partner_transactions s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id AND s.status IN ('draft','posted'))
        AND NOT EXISTS(SELECT 1 FROM bank_transaction_matches m WHERE m.company_id=t.company_id AND m.bank_transaction_id=t.id AND m.match_type<>'document')
      ORDER BY t.transaction_date DESC,t.id`,[companyId,salaryVisible])).rows.filter((r:{amount:string;allocated_amount:string})=>cents(r.amount.replace(/^-/,''))>cents(String(r.allocated_amount)));
    const transactions=await eligible('outflow'),refund_transactions=await eligible('inflow');
    const counterparties=(await this.db.query(`SELECT id,name,type FROM counterparties WHERE company_id=$1 AND is_active ORDER BY name,id`,[companyId])).rows;
    const present=(rows:typeof transactions)=>rows.map((r:{amount:string;allocated_amount:string;[k:string]:unknown})=>({...r,available_amount:money(cents(r.amount.replace(/^-/,''))-cents(String(r.allocated_amount)))}));
    return{bank_transactions:present(transactions),refund_transactions:present(refund_transactions),counterparties};
  }

  async forCost(companyId:string,costId:string,salaryVisible:boolean){
    const cost=await this.costFromPool(companyId,costId);this.visible(cost,salaryVisible);
    const rows=(await this.db.query<PaymentRow & {reversed_amount:string;reversible_amount:string}>(`SELECT a.id,a.company_id,a.bank_transaction_id,a.cost_record_id,a.cost_allocation_id,a.allocation_type,a.beneficiary_type,a.counterparty_id,a.reverses_allocation_id,a.amount::text,a.note,a.reason,a.created_by,a.created_at::text,
        t.transaction_date::text,t.bank_reference,t.description bank_description,cp.name counterparty_name,
        COALESCE(rv.amount,0)::text reversed_amount,(a.amount-COALESCE(rv.amount,0))::text reversible_amount
      FROM employee_cost_payment_allocations a JOIN bank_transactions t ON t.id=a.bank_transaction_id AND t.company_id=a.company_id
      LEFT JOIN counterparties cp ON cp.id=a.counterparty_id AND cp.company_id=a.company_id
      LEFT JOIN LATERAL (SELECT SUM(x.amount) amount FROM employee_cost_payment_allocations x WHERE x.company_id=a.company_id AND x.reverses_allocation_id=a.id) rv ON true
      WHERE a.company_id=$1 AND a.cost_record_id=$2 ORDER BY t.transaction_date,a.created_at,a.id`,[companyId,costId])).rows;
    return{payments:rows};
  }
  private async costFromPool(companyId:string,id:string){
    const row=(await this.db.query<CostRow>(`SELECT r.id,r.employee_id,e.employee_number,e.display_name,r.nature,r.category,r.currency_code,r.total_amount::text,r.status,r.service_period_start::text,r.service_period_end::text,r.supersedes_id FROM employee_cost_records r JOIN employees e ON e.id=r.employee_id AND e.company_id=r.company_id WHERE r.id=$1 AND r.company_id=$2`,[id,companyId])).rows[0];
    if(!row)throw missing();return row;
  }

  async allocate(companyId:string,actor:string,costId:string,input:{bankTransactionId:string;costAllocationId:string;amount:string;beneficiaryType:'employee'|'counterparty';counterpartyId:string|null;note:string|null},salaryVisible:boolean){
    return this.tx(async c=>{
      const bank=(await c.query<{id:string;transaction_date:string;amount:string;currency_code:string;source_kind:string;manual_category:string|null;reconciliation_status:string}>(`SELECT id,transaction_date::text,amount::text,currency_code,source_kind,manual_category,reconciliation_status FROM bank_transactions WHERE id=$1 AND company_id=$2 FOR UPDATE`,[input.bankTransactionId,companyId])).rows[0];
      if(!bank)throw missing();
      await assertAccountingDateWritable(companyId,bank.transaction_date,c);
      const cost=await this.cost(c,companyId,costId,true);this.visible(cost,salaryVisible);
      if(cost.status!=='approved'||cost.nature==='employee_deduction'||cost.supersedes_id)throw conflict('Only active approved earnings and employer costs can be paid');
      if(!salaryVisible&&cost.nature!=='employer_cost')throw forbidden();
      if(bank.reconciliation_status==='reconciled'||bank.amount.startsWith('+')||!bank.amount.startsWith('-'))throw conflict('Choose an unreconciled company bank outflow');
      if(bank.currency_code.trim()!==cost.currency_code.trim())throw conflict('Bank transaction and cost currencies must match');
      if(bank.source_kind==='manual'&&!['supplier_payment','government_payment','other'].includes(bank.manual_category??''))throw conflict('This manual bank transaction category cannot pay employee costs');
      if(input.beneficiaryType==='employee'){
        if(input.counterpartyId!==null||cost.nature!=='earning')throw invalid('Direct employee payments are valid for earnings');
      }else{
        if(!input.counterpartyId||!(await c.query('SELECT 1 FROM counterparties WHERE id=$1 AND company_id=$2 AND is_active',[input.counterpartyId,companyId])).rowCount)throw invalid('Choose an active third-party counterparty in this company');
      }
      const allocation=(await c.query<{amount:string;allocation_month:string;fiscal_year_id:string}>(`SELECT amount::text,allocation_month::text,fiscal_year_id FROM employee_cost_allocations WHERE id=$1 AND cost_record_id=$2 AND company_id=$3 FOR UPDATE`,[input.costAllocationId,costId,companyId])).rows[0];
      if(!allocation)throw missing();
      const prior=(await c.query<{paid:string}>(`SELECT COALESCE(SUM(CASE WHEN allocation_type='payment' THEN amount ELSE -amount END),0)::text paid FROM employee_cost_payment_allocations WHERE company_id=$1 AND cost_allocation_id=$2`,[companyId,input.costAllocationId])).rows[0]!.paid;
      if(cents(prior)+cents(input.amount)>cents(allocation.amount))throw conflict('Payment exceeds the remaining allocated cost');
      const row=(await c.query<PaymentRow>(`INSERT INTO employee_cost_payment_allocations(company_id,bank_transaction_id,cost_record_id,cost_allocation_id,allocation_type,beneficiary_type,counterparty_id,amount,note,created_by)
        VALUES($1,$2,$3,$4,'payment',$5,$6,$7,$8,$9) RETURNING *,created_at::text`,[companyId,input.bankTransactionId,costId,input.costAllocationId,input.beneficiaryType,input.counterpartyId,input.amount,input.note,actor])).rows[0]!;
      await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'employee_cost_payment.allocate',entity_type:'employee_cost_payment',entity_id:row.id,before_data:null,after_data:{allocation_type:'payment',cost_record_id:costId,cost_allocation_id:input.costAllocationId,bank_transaction_id:input.bankTransactionId,amount:input.amount,beneficiary_type:input.beneficiaryType,counterparty_id:input.counterpartyId}},c);
      return{payment:row,remaining_cost_amount:money(cents(allocation.amount)-cents(prior)-cents(input.amount))};
    });
  }

  async reverse(companyId:string,actor:string,allocationId:string,input:{bankTransactionId:string;amount:string;reason:string;note:string|null},salaryVisible:boolean){
    // A preliminary read discovers the target; all writes then lock bank, cost, and original allocation in that order.
    const target=(await this.db.query<{company_id:string;cost_record_id:string;cost_allocation_id:string}>(`SELECT company_id,cost_record_id,cost_allocation_id FROM employee_cost_payment_allocations WHERE id=$1 AND company_id=$2 AND allocation_type='payment'`,[allocationId,companyId])).rows[0];
    if(!target)throw missing();
    return this.tx(async c=>{
      const bank=(await c.query<{transaction_date:string;amount:string;currency_code:string;reconciliation_status:string}>(`SELECT transaction_date::text,amount::text,currency_code,reconciliation_status FROM bank_transactions WHERE id=$1 AND company_id=$2 FOR UPDATE`,[input.bankTransactionId,companyId])).rows[0];
      if(!bank)throw missing();await assertAccountingDateWritable(companyId,bank.transaction_date,c);
      const cost=await this.cost(c,companyId,target.cost_record_id,true);this.visible(cost,salaryVisible);
      const original=(await c.query<PaymentRow>(`SELECT * FROM employee_cost_payment_allocations WHERE id=$1 AND company_id=$2 AND allocation_type='payment' FOR UPDATE`,[allocationId,companyId])).rows[0];
      if(!original||original.cost_allocation_id!==target.cost_allocation_id)throw missing();
      if(bank.reconciliation_status==='reconciled'||Number(bank.amount)<=0)throw conflict('Choose an unreconciled bank inflow for a reversal');
      if(bank.currency_code.trim()!==cost.currency_code.trim())throw conflict('Bank transaction and cost currencies must match');
      const reversed=(await c.query<{amount:string}>(`SELECT COALESCE(SUM(amount),0)::text amount FROM employee_cost_payment_allocations WHERE company_id=$1 AND reverses_allocation_id=$2`,[companyId,allocationId])).rows[0]!.amount;
      if(cents(reversed)+cents(input.amount)>cents(original.amount))throw conflict('Reversal exceeds the unreversed payment amount');
      const row=(await c.query<PaymentRow>(`INSERT INTO employee_cost_payment_allocations(company_id,bank_transaction_id,cost_record_id,cost_allocation_id,allocation_type,beneficiary_type,counterparty_id,reverses_allocation_id,amount,note,reason,created_by)
        VALUES($1,$2,$3,$4,'reversal',$5,$6,$7,$8,$9,$10,$11) RETURNING *,created_at::text`,[companyId,input.bankTransactionId,original.cost_record_id,original.cost_allocation_id,original.beneficiary_type,original.counterparty_id,allocationId,input.amount,input.note,input.reason,actor])).rows[0]!;
      await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'employee_cost_payment.reverse',entity_type:'employee_cost_payment',entity_id:row.id,before_data:{allocation_type:'payment',reverses_allocation_id:allocationId},after_data:{allocation_type:'reversal',cost_record_id:original.cost_record_id,cost_allocation_id:original.cost_allocation_id,bank_transaction_id:input.bankTransactionId,amount:input.amount,beneficiary_type:original.beneficiary_type,counterparty_id:original.counterparty_id},reason:input.reason},c);
      return{payment:row,remaining_reversible_amount:money(cents(original.amount)-cents(reversed)-cents(input.amount))};
    });
  }

  async report(companyId:string,fiscalYearId:string,month:string|null,salaryVisible:boolean){
    const fy=(await this.db.query<{start_date:string;end_date:string;name:string}>(`SELECT start_date::text,end_date::text,name FROM fiscal_years WHERE id=$1 AND company_id=$2`,[fiscalYearId,companyId])).rows[0];
    if(!fy)throw missing();
    if(month&&(!DATE.test(month)||new Date(`${month}T00:00:00Z`).toISOString().slice(0,10)!==month||month.slice(-2)!=='01'||month<fy.start_date||month>fy.end_date))throw invalid('Month is outside the selected fiscal year');
    const end=month?new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10):fy.end_date;
    const rows=(await this.db.query(`SELECT e.id employee_id,e.employee_number,e.display_name,r.category,r.nature,a.allocation_month::text,currency_code,
        SUM(a.amount)::text recorded_cost,
        SUM(COALESCE(paid.net_paid,0))::text verified_paid,
        SUM(CASE WHEN r.nature='employee_deduction' THEN 0 ELSE a.amount-COALESCE(paid.net_paid,0) END)::text outstanding,
        SUM(COALESCE(paid.period_paid,0))::text paid_in_period
      FROM employee_cost_allocations a JOIN employee_cost_records r ON r.id=a.cost_record_id AND r.company_id=a.company_id
      JOIN employees e ON e.id=r.employee_id AND e.company_id=r.company_id
      LEFT JOIN LATERAL (SELECT
          COALESCE(SUM(CASE WHEN x.allocation_type='payment' AND t.transaction_date<=$4::date THEN x.amount WHEN x.allocation_type='reversal' AND t.transaction_date<=$4::date THEN -x.amount ELSE 0 END),0) net_paid,
          COALESCE(SUM(CASE WHEN t.transaction_date BETWEEN $5::date AND $4::date THEN CASE WHEN x.allocation_type='payment' THEN x.amount ELSE -x.amount END ELSE 0 END),0) period_paid
        FROM employee_cost_payment_allocations x JOIN bank_transactions t ON t.id=x.bank_transaction_id AND t.company_id=x.company_id
        WHERE x.company_id=a.company_id AND x.cost_allocation_id=a.id) paid ON true
      WHERE a.company_id=$1 AND a.fiscal_year_id=$2 AND ($3::date IS NULL OR a.allocation_month=$3)
        AND r.status='approved' AND ($6::boolean OR r.nature='employer_cost')
        AND NOT EXISTS(SELECT 1 FROM employee_cost_records newer WHERE newer.company_id=r.company_id AND newer.supersedes_id=r.id AND newer.status='approved')
      GROUP BY e.id,e.employee_number,e.display_name,r.category,r.nature,a.allocation_month,r.currency_code
      ORDER BY e.employee_number,e.display_name,r.nature,r.category,a.allocation_month,r.currency_code`,[companyId,fiscalYearId,month,end,month??fy.start_date,salaryVisible])).rows;
    return{fiscal_year:{id:fiscalYearId,name:fy.name,start_date:fy.start_date,end_date:fy.end_date},month,paid_as_of:end,basis:'approved_cost_allocations_and_verified_bank_transactions',rows};
  }
}
