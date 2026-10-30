import { createHash } from 'node:crypto';

export class ZakatNotFoundError extends Error {}
export class ZakatValidationError extends Error { constructor(message: string, public code = 'ZAKAT_INVALID', public blockers: string[] = []) { super(message); } }
export class ZakatConflictError extends Error { constructor(message: string, public code = 'ZAKAT_CONFLICT', public blockers: string[] = []) { super(message); } }

export const OWNERSHIP_CLASSES = ['saudi_natural', 'gcc_natural', 'saudi_entity_confirmed', 'gcc_entity_confirmed', 'other'] as const;
export const ENTITY_CLASSES = ['saudi_entity_confirmed', 'gcc_entity_confirmed'];
export const QUALIFYING_CLASSES = ['saudi_natural', 'gcc_natural', 'saudi_entity_confirmed', 'gcc_entity_confirmed'];

export const ZAKAT_CLASSES = [
  'addition_equity', 'addition_provision_equity', 'addition_non_current_liability', 'addition_provision_non_current_liability',
  'addition_partner_loan_equity', 'addition_partner_loan_liability', 'current_liability',
  'deduction_fixed_assets', 'deduction_intangibles', 'deduction_other_article', 'not_deducted', 'not_deducted_inventory', 'investment_unsupported',
] as const;
export type ZakatClass = typeof ZAKAT_CLASSES[number];
/** Classes whose confirmation needs a supporting document (mirrors the table CHECK). */
export const EVIDENCE_CLASSES: string[] = ['addition_provision_equity', 'addition_provision_non_current_liability', 'addition_partner_loan_liability', 'deduction_fixed_assets', 'deduction_intangibles', 'deduction_other_article'];

/** Balance-sheet categories that take part in the Zakat worksheet. */
export const BALANCE_CATEGORIES = ['current_asset', 'non_current_asset', 'current_liability', 'non_current_liability', 'equity'];
export const PROFIT_CATEGORIES = ['revenue', 'cost_of_sales', 'operating_expense', 'finance_income', 'finance_expense', 'other_income', 'other_expense'];
export const EXPENSE_CATEGORIES = ['cost_of_sales', 'operating_expense', 'finance_expense', 'other_expense'];

/** Starting suggestions only (never confirmed automatically). Source: G6-1 spec section 3.2; the accountant must confirm each one. */
export function suggestClass(category: string): { zakat_class: ZakatClass; reg_article: string } | null {
  switch (category) {
    case 'equity': return { zakat_class: 'addition_equity', reg_article: 'م23(1)' };
    case 'non_current_liability': return { zakat_class: 'addition_non_current_liability', reg_article: 'م29(1)' };
    case 'current_liability': return { zakat_class: 'current_liability', reg_article: 'م25 / م29(2)' };
    case 'current_asset': return { zakat_class: 'not_deducted', reg_article: 'م26' };
    case 'non_current_asset': return { zakat_class: 'deduction_fixed_assets', reg_article: 'م26(4) / م48' };
    default: return null;
  }
}

/**
 * Regulatory gates that keep the final Zakat payable calculation inactive. They are code constants on purpose:
 * no user, role or request can mark them verified. Removing one requires a reviewed code change after accountant sign-off.
 */
export const REGULATORY_GATES = [
  { code: 'B0', key: 'amendment_1248', article: 'القرار 1248' },
  { code: 'B1', key: 'day_count_denominator', article: 'م15' },
  { code: 'B2', key: 'saudi_definition_indirect_ownership', article: 'م3 / م13' },
  { code: 'B3', key: 'rounding_rule', article: '—' },
  { code: 'B4', key: 'liability_cap_order', article: 'م23(2) / م25 / م29(2)(ب)' },
  { code: 'B5', key: 'upper_limit_effect', article: 'م28' },
  { code: 'B7', key: 'book_profit_after_zakat_circularity', article: 'م23(3)' },
  { code: 'B9', key: 'accountant_signoff_reference_cases', article: '—' },
] as const;

export const calculationGate = () => ({
  status: 'blocked' as const,
  payable_amount: null,
  rules_version: '1445-AR',
  amendment_ref: null,
  blockers: REGULATORY_GATES.map((g) => ({ ...g, status: 'unverified' as const })),
});

export const stable = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
    : JSON.stringify(value ?? null);
export const fp = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export const halalas = (value: string): bigint => {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const amount = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -amount : amount;
};
export const money = (value: bigint) => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${((value < 0n ? -value : value) % 100n).toString().padStart(2, '0')}`;

/** Standard 12-month fiscal year starting in 2024 or later (365/366 days; whole calendar-month span). */
export function scopeProblems(start: string, end: string): string[] {
  const problems: string[] = [];
  if (start < '2024-01-01') problems.push('fiscal_year_before_2024');
  const s = new Date(`${start}T00:00:00Z`), e = new Date(`${end}T00:00:00Z`);
  const nextDay = new Date(e.getTime() + 86400000);
  const months = (nextDay.getUTCFullYear() - s.getUTCFullYear()) * 12 + (nextDay.getUTCMonth() - s.getUTCMonth());
  if (months !== 12 || nextDay.getUTCDate() !== s.getUTCDate()) problems.push('fiscal_year_not_12_months');
  return problems;
}
