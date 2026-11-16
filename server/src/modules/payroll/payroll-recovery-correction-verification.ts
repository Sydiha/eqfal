import { PoolClient } from 'pg';

/** Exact, transaction-local verification for a posted employee-advance recovery correction. */
export async function payrollRecoveryCorrectionJournalIsExact(client:PoolClient,companyId:string,journalId:string,correctionId:string):Promise<boolean>{
 const result=await client.query<{valid:boolean}>(`WITH source AS (
   SELECT c.id,c.recovery_id,c.amount,c.accounting_date,c.status,c.requested_by,c.approved_by,c.posted_by,
     r.employee_id,r.advance_id,r.amount recovery_amount,d.id draft_id
   FROM payroll_recovery_corrections c
   JOIN payroll_employee_advance_recoveries r ON r.id=c.recovery_id AND r.company_id=c.company_id
   JOIN payroll_drafts d ON d.id=r.draft_id AND d.company_id=r.company_id
   WHERE c.company_id=$1 AND c.id=$3 AND c.status='approved' AND c.approved_by IS NOT NULL AND (c.requested_by<>c.approved_by OR has_privileged_financial_authority(c.company_id,c.approved_by))
     AND r.status='posted' AND d.status='approved'
 ), journal AS (
   SELECT j.id,j.accounting_date FROM journal_entries j JOIN source s ON j.company_id=$1 AND j.source_type='payroll_recovery_correction' AND j.source_id=s.id
   WHERE j.id=$2 AND j.entry_type='standard'
 ), expected AS (
   SELECT am.account_id,s.amount::numeric debit,0::numeric credit,'employee_salary_advance_recovery_reversal'::text memo
   FROM source s JOIN employee_salary_advance_account_mappings am ON am.company_id=$1
   JOIN accounts a ON a.id=am.account_id AND a.company_id=$1 AND a.is_active AND a.account_type='asset' AND a.statement_category='current_asset'
   UNION ALL
   SELECT pm.account_id,0::numeric,s.amount::numeric,'employee_salary_advance_payroll_liability_reversal'
   FROM source s JOIN payroll_account_mappings pm ON pm.company_id=$1 AND pm.mapping_key='net_payroll_liability'
   JOIN accounts a ON a.id=pm.account_id AND a.company_id=$1 AND a.is_active AND a.account_type='liability'
 ), actual AS (SELECT account_id,debit,credit,memo FROM journal_lines WHERE company_id=$1 AND journal_entry_id=$2)
 SELECT EXISTS(SELECT 1 FROM source s JOIN journal j ON j.id=$2 WHERE s.accounting_date=j.accounting_date
   AND s.amount<=s.recovery_amount
   AND (SELECT COALESCE(sum(x.amount),0) FROM payroll_recovery_corrections x WHERE x.company_id=$1 AND x.recovery_id=s.recovery_id AND x.status IN('approved','posted') AND x.id<>s.id)+s.amount<=s.recovery_amount
   AND (SELECT count(*) FROM journal_lines x WHERE x.company_id=$1 AND x.journal_entry_id=j.id)=2
   AND NOT EXISTS((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected))) valid`,[companyId,journalId,correctionId]);
 return result.rows[0]?.valid===true;
}
