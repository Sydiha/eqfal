import { createHash } from 'node:crypto';

// G6-1 pure rules: eligibility, ownership verification, classification validity and readiness.
// Nothing here computes a Zakat base or an amount due: the regulatory gates (B0, B3, B4, B7) are unverified and the calculation is not activated.

export const OWNERSHIP_CLASSES = ['saudi_natural', 'gcc_natural', 'saudi_entity', 'gcc_entity', 'other', 'unknown'] as const;
export type OwnershipClass = (typeof OWNERSHIP_CLASSES)[number];
export const QUALIFYING_CLASSES: readonly OwnershipClass[] = ['saudi_natural', 'gcc_natural', 'saudi_entity', 'gcc_entity'];
export const ENTITY_CLASSES: readonly OwnershipClass[] = ['saudi_entity', 'gcc_entity'];

type Category = 'current_asset' | 'non_current_asset' | 'current_liability' | 'non_current_liability' | 'equity';
const ASSETS: Category[] = ['current_asset', 'non_current_asset'];
const LIABILITIES: Category[] = ['current_liability', 'non_current_liability'];
const ALL: Category[] = [...ASSETS, ...LIABILITIES, 'equity'];

/** Closed list of accountant-selectable classifications. Allowed statement categories prevent obviously inconsistent confirmations. */
export const ZAKAT_TYPES: Record<string, { categories: Category[]; evidence: boolean }> = {
  equity_capital: { categories: ['equity'], evidence: false },
  equity_reserve: { categories: ['equity'], evidence: false },
  retained_earnings: { categories: ['equity'], evidence: false },
  carried_forward_loss: { categories: ['equity'], evidence: false },
  treasury_shares: { categories: ['equity'], evidence: false },
  provision_equity_like: { categories: LIABILITIES, evidence: false },
  provision_eosb_leave: { categories: LIABILITIES, evidence: false },
  partner_loan_credit_liability: { categories: LIABILITIES, evidence: true },
  partner_loan_credit_equity: { categories: [...LIABILITIES, 'equity'], evidence: false },
  non_current_liability: { categories: ['non_current_liability'], evidence: false },
  current_liability: { categories: ['current_liability'], evidence: false },
  deductible_fixed_asset: { categories: ['non_current_asset'], evidence: false },
  deductible_intangible: { categories: ['non_current_asset'], evidence: false },
  deductible_spare_or_raw_material: { categories: ASSETS, evidence: true },
  statutory_deposit: { categories: ASSETS, evidence: true },
  deferred_tax_asset: { categories: ASSETS, evidence: false },
  deductible_investment: { categories: ['non_current_asset'], evidence: true },
  non_deductible_asset: { categories: ASSETS, evidence: false },
  other_manual: { categories: ALL, evidence: true },
};

export const CLASSIFIABLE_CATEGORIES: readonly string[] = ALL;

/** Unit conversion without floats: amounts arrive as decimal strings. */
export function toCents(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const amount = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -amount : amount;
}
/** Ownership percentages carry four decimals; 100.0000% is 1_000_000 units. */
export function toBps4(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole || '0') * 10000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
}
export const FULL_OWNERSHIP = 1_000_000n;

export const fingerprintOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Standard scope: a calendar 12-month fiscal year (end = start + 1 year - 1 day) that starts on or after 2024-01-01. */
export function unsupportedPeriodReason(start: string, end: string): string | null {
  if (start < '2024-01-01') return 'fiscal_year_starts_before_2024';
  const s = new Date(`${start}T00:00:00Z`);
  const expected = new Date(Date.UTC(s.getUTCFullYear() + 1, s.getUTCMonth(), s.getUTCDate() - 1));
  return expected.toISOString().slice(0, 10) === end ? null : 'fiscal_year_not_12_months';
}

export type OwnershipInputs = {
  asOf: string;
  profile: { id: string; ownership_context: string; tax_treatment: string } | null;
  partners: { id: string; name: string; is_active: boolean }[];
  periods: { partner_id: string; pct: string | null; effective_from: string | null; effective_to: string | null; verification_status: string }[];
  eligibility: { id: string; partner_id: string; ownership_class: string; effective_from: string; effective_to: string | null; evidence_document_id: string; verification_status: string; confirmed_by_user_id: string | null; confirmed_at: string | null }[];
};
export type OwnershipVerification = {
  as_of_date: string;
  qualified: boolean;
  blockers: string[];
  total_ownership_bps4: string;
  profile: { id: string; ownership_context: string; tax_treatment: string } | null;
  partners: { partner_id: string; name: string; ownership_bps4: string; eligibility: null | { id: string; ownership_class: string; evidence_document_id: string; confirmed_by_user_id: string | null; confirmed_at: string | null } }[];
};

const covers = (from: string | null, to: string | null, day: string) => from !== null && from <= day && (to === null || to >= day);

/** Qualifying 100% Saudi/GCC ownership at the fiscal-year end. Missing data is a blocker, never an assumption. */
export function verifyOwnership(input: OwnershipInputs): OwnershipVerification {
  const blockers = new Set<string>();
  const { asOf } = input;
  if (!input.profile) blockers.add('zakat_path_not_approved');
  else {
    if (input.profile.tax_treatment !== 'zakat_applicable') blockers.add('zakat_path_not_approved');
    if (input.profile.ownership_context !== 'saudi_gcc_only') blockers.add('profile_ownership_context_not_saudi_gcc');
  }
  if (input.periods.some((p) => p.verification_status !== 'confirmed' && (p.effective_from === null || covers(p.effective_from, p.effective_to, asOf)))) blockers.add('unconfirmed_ownership_period');
  const confirmed = input.periods.filter((p) => p.verification_status === 'confirmed' && p.pct !== null && covers(p.effective_from, p.effective_to, asOf));
  const byPartner = new Map<string, bigint>();
  for (const p of confirmed) byPartner.set(p.partner_id, (byPartner.get(p.partner_id) ?? 0n) + toBps4(p.pct!));
  const total = [...byPartner.values()].reduce((sum, v) => sum + v, 0n);
  if (byPartner.size === 0) blockers.add('no_confirmed_ownership');
  else if (total !== FULL_OWNERSHIP) blockers.add('ownership_total_not_100');
  for (const partner of input.partners) if (partner.is_active && !byPartner.has(partner.id)) blockers.add('partner_without_ownership_at_year_end');
  const rows = [...byPartner.entries()].map(([partnerId, bps]) => {
    const name = input.partners.find((p) => p.id === partnerId)?.name ?? '';
    const forPartner = input.eligibility.filter((e) => e.partner_id === partnerId && covers(e.effective_from, e.effective_to, asOf));
    const confirmedRow = forPartner.find((e) => e.verification_status === 'confirmed');
    if (!confirmedRow) blockers.add(forPartner.length ? 'partner_eligibility_unconfirmed' : 'partner_eligibility_missing');
    else if (!QUALIFYING_CLASSES.includes(confirmedRow.ownership_class as OwnershipClass)) blockers.add('partner_class_not_qualifying');
    return {
      partner_id: partnerId, name, ownership_bps4: bps.toString(),
      eligibility: confirmedRow ? { id: confirmedRow.id, ownership_class: confirmedRow.ownership_class, evidence_document_id: confirmedRow.evidence_document_id, confirmed_by_user_id: confirmedRow.confirmed_by_user_id, confirmed_at: confirmedRow.confirmed_at } : null,
    };
  }).sort((a, b) => a.partner_id.localeCompare(b.partner_id));
  const sortedBlockers = [...blockers].sort();
  return { as_of_date: asOf, qualified: sortedBlockers.length === 0, blockers: sortedBlockers, total_ownership_bps4: total.toString(), profile: input.profile, partners: rows };
}

export type BalanceAccount = { account_id: string; code: string; name: string; name_ar: string | null; statement_category: string; account_type: string; is_contra: boolean; amount_cents: string };
export type BalancesSnapshot = { as_of_date: string; accounts: BalanceAccount[]; current_period_earnings_cents: string; totals_cents: Record<string, string> };

export function unclassifiedAccounts(balances: BalancesSnapshot | null, classified: Set<string>) {
  if (!balances) return [];
  return balances.accounts.filter((a) => CLASSIFIABLE_CATEGORIES.includes(a.statement_category) && BigInt(a.amount_cents) !== 0n && !classified.has(a.account_id));
}

export type GateRow = { code: string; title: string; article_ref: string; blocks_approval: boolean; status: string; verified_by_name: string | null; verified_on: string | null; verification_reference: string | null };

/** Gates that must be verified before any calculation or approval is activated. Enforced in code even if a gate row is missing or downgraded in the database. */
export const REQUIRED_BLOCKING_GATES = ['B0_amendment_1248', 'B3_rounding', 'B4_cap_ordering', 'B7_book_profit_after_zakat', 'B9_reference_cases_approval'] as const;

export type ReadinessInput = {
  ownership: OwnershipVerification;
  periodReason: string | null;
  declarationsOk: boolean;
  balances: BalancesSnapshot | null;
  classifiedAccountIds: Set<string>;
  balancesDrift: boolean;
  ownershipDrift: boolean;
  gates: GateRow[];
  investmentClassifications?: number;
};
export type Readiness = {
  preparation_blockers: string[];
  gate_blockers: string[];
  unclassified_account_count: number;
  can_submit: boolean;
  can_approve: boolean;
  calculation_performed: false;
  payable_amount: null;
  payable_amount_status: 'withheld_regulatory_gates' | 'not_implemented';
};

/** Preparation blockers gate submission/review; blocking regulatory gates additionally gate approval. No amount is ever produced. */
export function evaluateReadiness(i: ReadinessInput): Readiness {
  const prep = new Set<string>(i.ownership.blockers);
  if (i.periodReason) prep.add(i.periodReason);
  if (!i.declarationsOk) prep.add('scope_declaration_missing');
  if (!i.balances) prep.add('balances_not_captured');
  const unclassified = unclassifiedAccounts(i.balances, i.classifiedAccountIds).length;
  if (unclassified > 0) prep.add('unclassified_balance');
  if ((i.investmentClassifications ?? 0) > 0) prep.add('unsupported_investment_deduction');
  if (i.balancesDrift) prep.add('balances_source_drift');
  if (i.ownershipDrift) prep.add('ownership_source_drift');
  const byCode = new Map(i.gates.map((g) => [g.code, g]));
  const gateBlockers = [...new Set([
    ...REQUIRED_BLOCKING_GATES.filter((code) => byCode.get(code)?.status !== 'verified'),
    ...i.gates.filter((g) => g.blocks_approval && g.status !== 'verified').map((g) => g.code),
  ])].sort();
  const prepList = [...prep].sort();
  const anyGateOpen = gateBlockers.length > 0 || i.gates.some((g) => g.status !== 'verified');
  return {
    preparation_blockers: prepList, gate_blockers: gateBlockers, unclassified_account_count: unclassified,
    can_submit: prepList.length === 0, can_approve: prepList.length === 0 && gateBlockers.length === 0,
    calculation_performed: false, payable_amount: null, payable_amount_status: anyGateOpen ? 'withheld_regulatory_gates' : 'not_implemented',
  };
}
