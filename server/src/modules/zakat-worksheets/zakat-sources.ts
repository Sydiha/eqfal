import type { Pool, PoolClient } from 'pg';
import { BALANCE_CATEGORIES, EXPENSE_CATEGORIES, PROFIT_CATEGORIES, QUALIFYING_CLASSES, ZakatNotFoundError, ZakatValidationError, fp, money } from './zakat.constants';

export type Runner = Pool | PoolClient;

export interface FiscalYearDates { start_date: string; end_date: string; }
export async function fiscalYearDates(company: string, year: string, r: Runner): Promise<FiscalYearDates> {
  const row = (await r.query<FiscalYearDates>('SELECT start_date::text, end_date::text FROM fiscal_years WHERE id=$1 AND company_id=$2', [year, company])).rows[0];
  if (!row) throw new ZakatNotFoundError();
  return row;
}

export interface OwnershipDetail {
  snapshot_date: string;
  profile: { id: string | null; ownership_context: string | null; tax_treatment: string | null };
  partners: Array<{ partner_id: string; name: string; percentage: string; eligibility_id: string | null; ownership_class: string | null; evidence_document_id: string | null }>;
  total_percentage: string;
}
export interface OwnershipVerification { qualified: boolean; reasons: string[]; detail: OwnershipDetail; fingerprint: string; }

/**
 * Verifies 100% qualifying ownership at the last day of the fiscal year. Nothing is inferred from missing data:
 * every gap (no confirmed period, no eligibility record, unconfirmed period, total != 100) produces an explicit reason.
 */
export async function verifyOwnership(company: string, year: string, r: Runner): Promise<OwnershipVerification> {
  const { end_date: date } = await fiscalYearDates(company, year, r);
  const reasons = new Set<string>();
  const profile = (await r.query<{ id: string; ownership_context: string; tax_treatment: string }>(
    `SELECT id, ownership_context, tax_treatment FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$2 AND (effective_to IS NULL OR effective_to>=$2) ORDER BY effective_from DESC, version_no DESC LIMIT 1`,
    [company, date])).rows[0];
  if (!profile || profile.ownership_context !== 'saudi_gcc_only') reasons.add('profile_ownership_context_not_saudi_gcc_only');
  const periods = (await r.query<{ partner_id: string; name: string; pct: string | null; effective_from: string | null; effective_to: string | null; verification_status: string }>(
    `SELECT o.partner_id::text, p.name, o.ownership_percentage::text pct, o.effective_from::text, o.effective_to::text, o.verification_status
       FROM partner_ownership_periods o JOIN partners p ON p.id=o.partner_id AND p.company_id=o.company_id
      WHERE o.company_id=$1 AND (o.effective_from IS NULL OR (o.effective_from<=$2 AND (o.effective_to IS NULL OR o.effective_to>=$2))) ORDER BY p.name, o.partner_id, o.effective_from`, [company, date])).rows;
  if (periods.some((p) => p.verification_status !== 'confirmed')) reasons.add('unconfirmed_ownership_period');
  const confirmed = periods.filter((p) => p.verification_status === 'confirmed' && p.effective_from !== null);
  if (!confirmed.length) reasons.add('no_confirmed_ownership');
  const byPartner = new Map<string, typeof confirmed>();
  for (const p of confirmed) byPartner.set(p.partner_id, [...(byPartner.get(p.partner_id) ?? []), p]);
  if ([...byPartner.values()].some((list) => list.length > 1)) reasons.add('ownership_period_overlap');
  const total = confirmed.reduce((sum, p) => sum + BigInt(Math.round(Number(p.pct) * 10000)), 0n);
  if (confirmed.length && total !== 1_000_000n) reasons.add('ownership_total_not_100');
  const eligibility = (await r.query<{ id: string; partner_id: string; ownership_class: string; evidence_document_id: string }>(
    `SELECT id::text, partner_id::text, ownership_class, evidence_document_id::text FROM zakat_partner_eligibility WHERE company_id=$1 AND status='active' AND effective_from<=$2 AND (effective_to IS NULL OR effective_to>=$2) ORDER BY partner_id, id`, [company, date])).rows;
  const partners: OwnershipDetail['partners'] = [];
  for (const [partnerId, list] of byPartner) {
    const records = eligibility.filter((e) => e.partner_id === partnerId);
    if (records.length > 1) reasons.add('eligibility_overlap');
    const rec = records[0];
    if (!rec) reasons.add('partner_eligibility_missing');
    else if (!QUALIFYING_CLASSES.includes(rec.ownership_class)) reasons.add('partner_not_qualifying');
    const pct = list.reduce((s, p) => s + BigInt(Math.round(Number(p.pct) * 10000)), 0n);
    partners.push({ partner_id: partnerId, name: list[0]!.name, percentage: `${pct / 10000n}.${(pct % 10000n).toString().padStart(4, '0')}`, eligibility_id: rec?.id ?? null, ownership_class: rec?.ownership_class ?? null, evidence_document_id: rec?.evidence_document_id ?? null });
  }
  const detail: OwnershipDetail = { snapshot_date: date, profile: { id: profile?.id ?? null, ownership_context: profile?.ownership_context ?? null, tax_treatment: profile?.tax_treatment ?? null }, partners, total_percentage: `${total / 10000n}.${(total % 10000n).toString().padStart(4, '0')}` };
  const sorted = [...reasons].sort();
  return { qualified: sorted.length === 0, reasons: sorted, detail, fingerprint: fp({ date, qualified: sorted.length === 0, reasons: sorted, detail: { ...detail, partners: partners.map(({ name: _n, ...p }) => p) } }) };
}

export interface BalanceAccount { account_id: string; code: string; name: string; account_type: string; statement_category: string; is_contra: boolean; balance_halalas: string; }
export interface BalanceSnapshot {
  as_of: string; fiscal_year_start: string; posted_journals: number;
  accounts: BalanceAccount[];
  book_net_profit_halalas: string; book_net_profit: string;
}

/** Fiscal-year financial-statement balances in integer halalas (same sign conventions as the statements service). */
export async function loadBalanceSnapshot(company: string, year: string, r: Runner): Promise<{ snapshot: BalanceSnapshot; fingerprint: string }> {
  const fy = await fiscalYearDates(company, year, r);
  const rows = (await r.query<{ account_id: string; code: string; name: string; account_type: string; statement_category: string; is_contra: boolean; debit_h: string; credit_h: string }>(
    `SELECT a.id::text account_id, a.code, a.name, a.account_type, a.statement_category, a.is_contra, ROUND(SUM(l.debit)*100)::text debit_h, ROUND(SUM(l.credit)*100)::text credit_h
       FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
      WHERE l.company_id=$1 AND j.fiscal_year_id=$2 AND j.status='posted' GROUP BY a.id ORDER BY a.code, a.id`, [company, year])).rows;
  if (rows.some((x) => x.statement_category === 'unmapped')) throw new ZakatValidationError('Posted activity exists on unmapped accounts', 'ZAKAT_UNMAPPED_ACCOUNTS');
  const posted = Number((await r.query<{ n: string }>("SELECT COUNT(*)::text n FROM journal_entries WHERE company_id=$1 AND fiscal_year_id=$2 AND status='posted'", [company, year])).rows[0]!.n);
  const natural = (x: typeof rows[number]) => (x.account_type === 'asset' || x.account_type === 'expense' ? BigInt(x.debit_h) - BigInt(x.credit_h) : BigInt(x.credit_h) - BigInt(x.debit_h));
  const accounts = rows.filter((x) => BALANCE_CATEGORIES.includes(x.statement_category)).map((x) => ({ account_id: x.account_id, code: x.code, name: x.name, account_type: x.account_type, statement_category: x.statement_category, is_contra: x.is_contra, balance_halalas: natural(x).toString() }));
  const profit = rows.filter((x) => PROFIT_CATEGORIES.includes(x.statement_category)).reduce((sum, x) => { const n = natural(x); return sum + (EXPENSE_CATEGORIES.includes(x.statement_category) ? -n : n); }, 0n);
  const snapshot: BalanceSnapshot = { as_of: fy.end_date, fiscal_year_start: fy.start_date, posted_journals: posted, accounts, book_net_profit_halalas: profit.toString(), book_net_profit: money(profit) };
  const fingerprint = fp({ as_of: fy.end_date, accounts: accounts.map(({ code: _c, name: _n, ...a }) => a), profit: snapshot.book_net_profit_halalas, posted });
  return { snapshot, fingerprint };
}
