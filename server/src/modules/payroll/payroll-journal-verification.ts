import { PoolClient } from 'pg';

/** Verify the generated journal against the approved payroll and current mappings inside the posting transaction. */
export async function payrollJournalIsExact(client: PoolClient, companyId: string, journalId: string, draftId: string): Promise<boolean> {
  const result = await client.query<{valid:boolean}>(`
    WITH draft AS (
      SELECT d.id,d.period_month,j.accounting_date FROM payroll_drafts d JOIN journal_entries j ON j.company_id=d.company_id AND j.source_id=d.id
      WHERE d.company_id=$1 AND d.id=$3 AND d.status='approved' AND j.id=$2 AND j.source_type='payroll'
    ), totals AS (
      SELECT COUNT(*) n,COALESCE(SUM(p.salary+p.allowances+p.bonus+p.overtime),0) earnings,
        COALESCE(SUM(p.deductions),0) deductions,COALESCE(SUM(p.employer_contributions),0) employer,
        COALESCE((SELECT sum(r.amount) FROM payroll_employee_advance_recoveries r WHERE r.company_id=$1 AND r.draft_id=$3 AND r.status='posted'),0) recoveries
      FROM payroll_draft_employees p JOIN draft d ON p.draft_id=d.id WHERE p.company_id=$1
    ), bonus AS (
      SELECT r.liability_account_id account_id, b.amount, e.employee_id, r.accounting_date
      FROM employee_bonus_balance_entries b
      JOIN employee_bonus_recognitions r ON r.company_id=b.company_id AND r.entitlement_id=b.entitlement_id
      JOIN employee_bonus_entitlements e ON e.company_id=b.company_id AND e.id=b.entitlement_id
      WHERE b.company_id=$1 AND b.journal_id=$2 AND b.kind='payroll'
    ), expected_raw AS (
      SELECT v.key,v.debit,v.credit FROM totals t CROSS JOIN LATERAL (VALUES
        ('earnings_expense',t.earnings-COALESCE((SELECT sum(amount) FROM bonus),0),0::numeric),('employer_contribution_expense',t.employer,0::numeric),
        ('net_payroll_liability',0::numeric,t.earnings-t.deductions-t.recoveries),('employee_deduction_liability',0::numeric,t.deductions),
        ('employer_contribution_liability',0::numeric,t.employer)) v(key,debit,credit)
      UNION ALL SELECT 'employee_salary_advance_receivable',0::numeric,t.recoveries FROM totals t WHERE t.recoveries>0
    ), expected AS (
      SELECT CASE WHEN e.key='employee_salary_advance_receivable' THEN am.account_id ELSE m.account_id END account_id,e.debit,e.credit,e.key memo FROM expected_raw e
      LEFT JOIN payroll_account_mappings m ON m.company_id=$1 AND m.mapping_key=e.key
      LEFT JOIN employee_salary_advance_account_mappings am ON am.company_id=$1
      JOIN accounts a ON a.company_id=$1 AND a.id=CASE WHEN e.key='employee_salary_advance_receivable' THEN am.account_id ELSE m.account_id END AND a.is_active
        AND a.account_type=CASE WHEN e.key IN ('earnings_expense','employer_contribution_expense') THEN 'expense' WHEN e.key='employee_salary_advance_receivable' THEN 'asset' ELSE 'liability' END
        AND (e.key<>'employee_salary_advance_receivable' OR (a.statement_category='current_asset' AND NOT EXISTS(SELECT 1 FROM bank_account_ledger_links b WHERE b.company_id=a.company_id AND b.account_id=a.id)))
      WHERE e.debit>0 OR e.credit>0
      UNION ALL SELECT account_id,amount,0::numeric,'recognized_bonus_liability' FROM bonus
    ), actual AS (
      SELECT account_id,debit,credit,memo FROM journal_lines WHERE company_id=$1 AND journal_entry_id=$2
    )
    SELECT EXISTS(
      SELECT 1 FROM draft d WHERE d.accounting_date=GREATEST(d.period_month,(SELECT max(b.accounting_date) FROM bonus b))
        AND d.accounting_date<d.period_month+interval '1 month'
    ) AND (SELECT n>0 AND earnings>=deductions+recoveries AND earnings+employer>0 FROM totals)
      AND NOT EXISTS (
        SELECT 1 FROM bonus b CROSS JOIN draft d
        LEFT JOIN payroll_draft_employees p ON p.company_id=$1 AND p.draft_id=d.id AND p.employee_id=b.employee_id
        GROUP BY b.employee_id,p.bonus
        HAVING p.bonus IS NULL OR sum(b.amount)>p.bonus OR bool_or(b.accounting_date>d.accounting_date)
      )
      AND (SELECT count(*)=5 FROM payroll_account_mappings m JOIN accounts a ON a.company_id=m.company_id AND a.id=m.account_id
        WHERE m.company_id=$1 AND a.is_active AND a.account_type=CASE WHEN m.mapping_key IN ('earnings_expense','employer_contribution_expense') THEN 'expense' ELSE 'liability' END)
      AND NOT EXISTS((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)) valid
  `,[companyId,journalId,draftId]);
  return result.rows[0]?.valid === true;
}
