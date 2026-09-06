-- Phase 1A.1: company-scoped accounting and tax profile foundation.
-- Workflow and effective-dating are represented here for future application
-- workflow work; this migration does not implement transitions.

INSERT INTO capabilities (id)
VALUES
  ('company_accounting_profile.view'),
  ('company_accounting_profile.manage'),
  ('company_accounting_profile.review'),
  ('company_accounting_profile.approve')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE company_accounting_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  workflow_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (workflow_status IN ('draft', 'needs_review', 'reviewed', 'approved')),

  accounting_framework TEXT NOT NULL
    CHECK (accounting_framework IN ('IFRS', 'IFRS for SMEs', 'Other / accountant-reviewed')),
  accounting_framework_notes TEXT,

  functional_currency TEXT NOT NULL CHECK (functional_currency ~ '^[A-Z]{3}$'),
  reporting_currency TEXT NOT NULL CHECK (reporting_currency ~ '^[A-Z]{3}$'),
  first_live_accounting_date DATE NOT NULL,

  vat_status TEXT NOT NULL
    CHECK (vat_status IN ('not_registered', 'registered', 'deregistered', 'needs_review')),
  vat_registration_number TEXT,
  vat_registered_from DATE,
  vat_deregistered_from DATE,
  vat_filing_frequency TEXT
    CHECK (vat_filing_frequency IN ('monthly', 'quarterly')),

  tax_treatment TEXT NOT NULL
    CHECK (tax_treatment IN ('zakat_applicable', 'income_tax_applicable', 'mixed', 'needs_review')),
  ownership_context TEXT NOT NULL
    CHECK (ownership_context IN ('saudi_gcc_only', 'includes_non_saudi', 'mixed', 'unknown_needs_review')),
  tax_effective_from DATE,
  tax_notes TEXT,

  wht_profile TEXT NOT NULL
    CHECK (wht_profile IN ('not_currently_applicable', 'potentially_applicable', 'needs_review')),
  has_non_resident_dealings TEXT NOT NULL
    CHECK (has_non_resident_dealings IN ('yes', 'no', 'unknown')),

  effective_from DATE,
  effective_to DATE,
  prepared_by_user_id UUID NOT NULL REFERENCES users(id),
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  approved_by_user_id UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  change_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, version_no),
  UNIQUE (id, company_id),
  CHECK (effective_from IS NOT NULL OR effective_to IS NULL),
  CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from),
  CHECK (workflow_status <> 'approved' OR effective_from IS NOT NULL),
  CHECK (
    vat_deregistered_from IS NULL OR vat_registered_from IS NULL
    OR vat_deregistered_from >= vat_registered_from
  ),
  CHECK (
    vat_status <> 'registered'
    OR (vat_registration_number IS NOT NULL
      AND vat_registered_from IS NOT NULL
      AND vat_filing_frequency IS NOT NULL)
  ),
  CHECK (
    vat_status <> 'deregistered'
    OR (vat_registration_number IS NOT NULL
      AND btrim(vat_registration_number) <> ''
      AND vat_registered_from IS NOT NULL
      AND vat_deregistered_from IS NOT NULL)
  ),
  CHECK (
    vat_registration_number IS NULL OR btrim(vat_registration_number) <> ''
  ),
  CHECK (
    vat_status <> 'not_registered'
    OR (vat_registration_number IS NULL
      AND vat_registered_from IS NULL
      AND vat_deregistered_from IS NULL
      AND vat_filing_frequency IS NULL)
  )
);

CREATE INDEX company_accounting_profiles_company_effective_idx
  ON company_accounting_profiles (company_id, effective_from, effective_to);
