import type { PoolClient } from 'pg';
import { CompanyAccountingProfile, VAT_KEYS } from './company-accounting-profile.types';

const INF = "'infinity'::date";
const overlap = (fromCol: string, toCol: string) => `${fromCol} <= COALESCE($3::date,${INF}) AND ${toCol} >= $2::date`;

/** Why a correction is refused; the first matching blocker wins. VAT blockers apply only when a vat_* field is being changed. */
export async function findCorrectionBlocker(client: PoolClient, original: CompanyAccountingProfile, changedKeys: readonly string[]): Promise<string | null> {
  const p = [original.company_id, original.effective_from, original.effective_to];
  const exists = async (sql: string, params: unknown[] = p) => Boolean((await client.query(sql, params)).rowCount);
  if (await exists(`SELECT 1 FROM ledger_source_authority WHERE company_id=$1 AND status='active' AND $2::date <= to_date + 1 AND COALESCE($3::date,${INF}) >= from_date LIMIT 1`)) return 'ACTIVATED_CUTOVER';
  if (await exists(`SELECT 1 FROM monthly_close_periods WHERE company_id=$1 AND status='closed' AND ${overlap('period_start', 'period_end')} LIMIT 1`)) return 'CLOSED_MONTH';
  if (await exists(`SELECT 1 FROM fiscal_years WHERE company_id=$1 AND status='closed' AND ${overlap('start_date', 'end_date')} LIMIT 1`)) return 'CLOSED_FISCAL_YEAR';
  if (await exists(`SELECT 1 FROM annual_closing_packages a JOIN fiscal_years f ON f.id=a.fiscal_year_id AND f.company_id=a.company_id
                    WHERE a.company_id=$1 AND a.status IN ('finalized','handed_off','reviewed','approved') AND ${overlap('f.start_date', 'f.end_date')} LIMIT 1`)) return 'ANNUAL_PACKAGE';
  if (await exists('SELECT 1 FROM tax_working_papers WHERE company_id=$1 AND accounting_profile_id=$2 LIMIT 1', [original.company_id, original.id])) return 'TAX_WORKPAPER';
  if (!changedKeys.some((k) => (VAT_KEYS as readonly string[]).includes(k))) return null;
  if (await exists(`SELECT 1 FROM vat_periods WHERE company_id=$1 AND ${overlap('period_start', 'period_end')} LIMIT 1`)) return 'VAT_PERIOD';
  if (await exists(`SELECT 1 FROM vat_returns r JOIN vat_periods v ON v.id=r.vat_period_id AND v.company_id=r.company_id WHERE r.company_id=$1 AND ${overlap('v.period_start', 'v.period_end')} LIMIT 1`)) return 'VAT_RETURN';
  if (await exists(`SELECT 1 FROM vat_adjustments a JOIN vat_periods v ON v.company_id=a.company_id AND v.id IN (a.original_vat_period_id, a.adjustment_vat_period_id)
                    WHERE a.company_id=$1 AND ${overlap('v.period_start', 'v.period_end')} LIMIT 1`)) return 'VAT_ADJUSTMENT';
  if (await exists(`SELECT 1 FROM document_vat_reviews WHERE company_id=$1 AND review_status='reviewed' AND tax_date >= $2::date AND tax_date <= COALESCE($3::date,${INF}) LIMIT 1`)) return 'VAT_DOCUMENT_REVIEW';
  if (await exists(`SELECT 1 FROM invoice_vat_reviews WHERE company_id=$1 AND tax_date >= $2::date AND tax_date <= COALESCE($3::date,${INF}) LIMIT 1`)) return 'VAT_INVOICE_REVIEW';
  if (await exists(`SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.id=l.journal_entry_id AND e.company_id=l.company_id
                    WHERE l.company_id=$1 AND l.memo IN ('VAT_INPUT','VAT_OUTPUT') AND e.status='posted' AND e.accounting_date >= $2::date AND e.accounting_date <= COALESCE($3::date,${INF}) LIMIT 1`)) return 'POSTED_VAT_JOURNAL';
  return null;
}
