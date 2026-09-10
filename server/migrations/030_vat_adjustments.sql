-- Phase 6B3: delta-based VAT adjustments for corrections discovered after period close.
CREATE TABLE vat_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  document_vat_review_id UUID NOT NULL,
  original_vat_period_id UUID NOT NULL,
  adjustment_vat_period_id UUID NOT NULL,
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('late_document','credit_note','debit_note','tax_date_correction','treatment_correction','recoverability_correction','amount_correction','other')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  taxable_amount_delta NUMERIC(18,2) NOT NULL DEFAULT 0,
  vat_amount_delta NUMERIC(18,2) NOT NULL DEFAULT 0,
  recoverable_vat_amount_delta NUMERIC(18,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','applied')),
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (id, company_id),
  FOREIGN KEY (document_vat_review_id, company_id) REFERENCES document_vat_reviews(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (original_vat_period_id, company_id) REFERENCES vat_periods(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (adjustment_vat_period_id, company_id) REFERENCES vat_periods(id, company_id) ON DELETE RESTRICT,
  CHECK (taxable_amount_delta <> 0 OR vat_amount_delta <> 0 OR recoverable_vat_amount_delta <> 0),
  CHECK ((status = 'draft' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL) OR (status IN ('reviewed','applied') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL))
);

CREATE INDEX vat_adjustments_company_adjustment_period_idx
  ON vat_adjustments (company_id, adjustment_vat_period_id, status);
CREATE INDEX vat_adjustments_company_review_idx
  ON vat_adjustments (company_id, document_vat_review_id, status);
