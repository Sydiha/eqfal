import { PoolClient } from 'pg';

/** Verify the generated journal against the approved payroll and current mappings inside the posting transaction. */
export async function payrollJournalIsExact(client: PoolClient, companyId: string, journalId: string, draftId: string): Promise<boolean> {
  const result = await client.query<{valid:boolean}>(`
    WITH draft AS (
      SELECT d.id,d.period_month FROM payroll_drafts d JOIN journal_entries j ON j.company_id=d.company_id AND j.source_id=d.id
      WHERE d.company_id=$1 AND d.id=$3 AND d.status='approved' AND j.id=$2 AND j.source_type='payroll' AND j.accounting_date=d.period_month
    ), totals AS (
      SELECT COUNT(*) n,COALESCE(SUM(p.salary+p.allowances+p.bonus+p.overtime),0) earnings,
        COALESCE(SUM(p.deductions),0) deductions,COALESCE(SUM(p.employer_contributions),0) employer
      FROM payroll_draft_employees p JOIN draft d ON p.draft_id=d.id WHERE p.company_id=$1
    ), expected_raw AS (
      SELECT v.key,v.debit,v.credit FROM totals t CROSS JOIN LATERAL (VALUES
        ('earnings_expense',t.earnings,0::numeric),('employer_contribution_expense',t.employer,0::numeric),
        ('net_payroll_liability',0::numeric,t.earnings-t.deductions),('employee_deduction_liability',0::numeric,t.deductions),
        ('employer_contribution_liability',0::numeric,t.employer)) v(key,debit,credit)
    ), expected AS (
      SELECT m.account_id,e.debit,e.credit,e.key memo FROM expected_raw e
      JOIN payroll_account_mappings m ON m.company_id=$1 AND m.mapping_key=e.key
      JOIN accounts a ON a.company_id=m.company_id AND a.id=m.account_id AND a.is_active
        AND a.account_type=CASE WHEN e.key IN ('earnings_expense','employer_contribution_expense') THEN 'expense' ELSE 'liability' END
      WHERE e.debit>0 OR e.credit>0
    ), actual AS (
      SELECT account_id,debit,credit,memo FROM journal_lines WHERE company_id=$1 AND journal_entry_id=$2
    )
    SELECT EXISTS(SELECT 1 FROM draft) AND (SELECT n>0 AND earnings>=deductions AND earnings+employer>0 FROM totals)
      AND (SELECT count(*)=5 FROM payroll_account_mappings m JOIN accounts a ON a.company_id=m.company_id AND a.id=m.account_id
        WHERE m.company_id=$1 AND a.is_active AND a.account_type=CASE WHEN m.mapping_key IN ('earnings_expense','employer_contribution_expense') THEN 'expense' ELSE 'liability' END)
      AND NOT EXISTS((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)) valid
  `,[companyId,journalId,draftId]);
  return result.rows[0]?.valid === true;
}
