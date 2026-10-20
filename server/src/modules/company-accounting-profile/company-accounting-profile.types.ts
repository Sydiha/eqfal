export const ACCOUNTING_FRAMEWORKS = ['IFRS', 'IFRS for SMEs', 'Other / accountant-reviewed'] as const;
export const VAT_STATUSES = ['not_registered', 'registered', 'deregistered', 'needs_review'] as const;
export const VAT_FILING_FREQUENCIES = ['monthly', 'quarterly'] as const;
export const TAX_TREATMENTS = ['zakat_applicable', 'income_tax_applicable', 'mixed', 'needs_review'] as const;
export const OWNERSHIP_CONTEXTS = ['saudi_gcc_only', 'includes_non_saudi', 'mixed', 'unknown_needs_review'] as const;
export const WHT_PROFILES = ['not_currently_applicable', 'potentially_applicable', 'needs_review'] as const;
export const NON_RESIDENT_DEALINGS = ['yes', 'no', 'unknown'] as const;

export type WorkflowStatus = 'draft' | 'needs_review' | 'reviewed' | 'approved' | 'superseded';
export type AccountingFramework = typeof ACCOUNTING_FRAMEWORKS[number];
export type VatStatus = typeof VAT_STATUSES[number];
export type VatFilingFrequency = typeof VAT_FILING_FREQUENCIES[number];
export type TaxTreatment = typeof TAX_TREATMENTS[number];
export type OwnershipContext = typeof OWNERSHIP_CONTEXTS[number];
export type WhtProfile = typeof WHT_PROFILES[number];
export type NonResidentDealings = typeof NON_RESIDENT_DEALINGS[number];

export interface CompanyAccountingProfile {
  id: string;
  company_id: string;
  version_no: number;
  workflow_status: WorkflowStatus;
  accounting_framework: AccountingFramework;
  accounting_framework_notes: string | null;
  functional_currency: string;
  reporting_currency: string;
  first_live_accounting_date: string;
  vat_status: VatStatus;
  vat_registration_number: string | null;
  vat_registered_from: string | null;
  vat_deregistered_from: string | null;
  vat_filing_frequency: VatFilingFrequency | null;
  tax_treatment: TaxTreatment;
  ownership_context: OwnershipContext;
  tax_effective_from: string | null;
  tax_notes: string | null;
  wht_profile: WhtProfile;
  has_non_resident_dealings: NonResidentDealings;
  effective_from: string | null;
  effective_to: string | null;
  prepared_by_user_id: string;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  approved_by_user_id: string | null;
  approved_at: Date | null;
  change_reason: string | null;
  corrects_profile_id: string | null;
  correction_reason: string | null;
  superseded_at: Date | null;
  superseded_by_profile_id: string | null;
  created_at: Date;
  updated_at: Date;
  closed_period_impact: boolean;
  professional_review_required: boolean;
}

export interface ProfileValues {
  accounting_framework: AccountingFramework;
  accounting_framework_notes: string | null;
  functional_currency: string;
  reporting_currency: string;
  first_live_accounting_date: string;
  vat_status: VatStatus;
  vat_registration_number: string | null;
  vat_registered_from: string | null;
  vat_deregistered_from: string | null;
  vat_filing_frequency: VatFilingFrequency | null;
  tax_treatment: TaxTreatment;
  ownership_context: OwnershipContext;
  tax_effective_from: string | null;
  tax_notes: string | null;
  wht_profile: WhtProfile;
  has_non_resident_dealings: NonResidentDealings;
  effective_from: string | null;
  effective_to: string | null;
  change_reason: string | null;
}

export type CreateProfileInput = ProfileValues;
export type UpdateProfileInput = Partial<ProfileValues>;

export class ProfileValidationError extends Error {}
export class ProfileNotFoundError extends Error {}
export class ProfileConflictError extends Error {}

/** Fields a corrective version may change. Everything else (period, start date, currencies) is frozen to the original. */
export const CORRECTABLE_KEYS = ['accounting_framework', 'accounting_framework_notes', 'vat_status', 'vat_registration_number', 'vat_registered_from', 'vat_deregistered_from', 'vat_filing_frequency', 'tax_treatment', 'ownership_context', 'tax_effective_from', 'tax_notes', 'wht_profile', 'has_non_resident_dealings'] as const;
export const FROZEN_KEYS = ['effective_from', 'effective_to', 'first_live_accounting_date', 'functional_currency', 'reporting_currency'] as const;
export const VAT_KEYS = ['vat_status', 'vat_registration_number', 'vat_registered_from', 'vat_deregistered_from', 'vat_filing_frequency'] as const;
export class ProfileForbiddenError extends Error {}
