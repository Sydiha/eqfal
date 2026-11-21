import type { PoolClient } from 'pg';

export async function bonusRecognitionIsExact(
  client: PoolClient, company: string, journal: string, entitlement: string,
): Promise<boolean> {
  const result = await client.query<{ valid: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM employee_bonus_recognitions r
      JOIN employee_bonus_entitlements e ON e.id=r.entitlement_id AND e.company_id=r.company_id
      JOIN journal_entries j ON j.id=r.journal_id AND j.company_id=r.company_id
      JOIN accounts expense ON expense.id=r.expense_account_id AND expense.company_id=r.company_id
      JOIN accounts liability ON liability.id=r.liability_account_id AND liability.company_id=r.company_id
      WHERE r.company_id=$1 AND j.id=$2 AND e.id=$3 AND e.approved_at IS NOT NULL AND e.amount>0
        AND j.accounting_date=r.accounting_date AND r.accounting_date<=CURRENT_DATE
        AND expense.account_type='expense' AND liability.account_type='liability'
        AND (SELECT count(*) FROM journal_lines l WHERE l.company_id=$1 AND l.journal_entry_id=$2)=2
        AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.company_id=$1 AND l.journal_entry_id=$2
          AND l.account_id=expense.id AND l.debit=e.amount AND l.credit=0)
        AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.company_id=$1 AND l.journal_entry_id=$2
          AND l.account_id=liability.id AND l.credit=e.amount AND l.debit=0)
    ) valid
  `, [company, journal, entitlement]);
  return result.rows[0]?.valid === true;
}

export async function bonusAdjustmentIsExact(
  client: PoolClient, company: string, journal: string, entry: string,
): Promise<boolean> {
  const result = await client.query<{ valid: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM employee_bonus_balance_entries b
      JOIN employee_bonus_recognitions r USING (company_id, entitlement_id)
      JOIN journal_entries j ON j.id=b.journal_id AND j.company_id=b.company_id
      WHERE b.company_id=$1 AND j.id=$2 AND b.id=$3
        AND b.kind IN ('increase','decrease') AND b.adjustment_reason IS NOT NULL
        AND j.accounting_date BETWEEN r.accounting_date AND CURRENT_DATE
        AND (SELECT count(*) FROM journal_lines l WHERE l.company_id=$1 AND l.journal_entry_id=$2)=2
        AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.company_id=$1 AND l.journal_entry_id=$2
          AND l.account_id=CASE WHEN b.kind='increase' THEN r.expense_account_id ELSE r.liability_account_id END
          AND l.debit=b.amount AND l.credit=0)
        AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.company_id=$1 AND l.journal_entry_id=$2
          AND l.account_id=CASE WHEN b.kind='increase' THEN r.liability_account_id ELSE r.expense_account_id END
          AND l.credit=b.amount AND l.debit=0)
    ) valid
  `, [company, journal, entry]);
  return result.rows[0]?.valid === true;
}
