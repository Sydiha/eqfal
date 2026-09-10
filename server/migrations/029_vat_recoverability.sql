-- Phase 6B2: governed input VAT recoverability on the existing VAT review.
ALTER TABLE document_vat_reviews
  ADD COLUMN recoverability_status TEXT,
  ADD COLUMN recoverable_vat_amount NUMERIC(18,2),
  ADD COLUMN recoverability_reason TEXT,
  ADD COLUMN recoverability_reviewed_by_user_id UUID REFERENCES users(id),
  ADD COLUMN recoverability_reviewed_at TIMESTAMPTZ;

UPDATE document_vat_reviews r
SET recoverability_status = CASE
  WHEN d.document_type = 'sale' THEN 'not_applicable'
  WHEN COALESCE(r.vat_amount, 0) = 0 THEN 'fully_recoverable'
  ELSE 'needs_review'
END,
recoverable_vat_amount = CASE
  WHEN d.document_type IN ('purchase', 'expense') AND COALESCE(r.vat_amount, 0) = 0 THEN 0
  ELSE NULL
END
FROM documents d
WHERE d.id = r.document_id AND d.company_id = r.company_id;

ALTER TABLE document_vat_reviews
  ALTER COLUMN recoverability_status SET NOT NULL,
  ADD CHECK (recoverability_status IN ('not_applicable', 'fully_recoverable', 'non_recoverable', 'partially_recoverable', 'needs_review')),
  ADD CHECK (recoverable_vat_amount IS NULL OR recoverable_vat_amount >= 0),
  ADD CHECK (recoverable_vat_amount IS NULL OR vat_amount IS NULL OR recoverable_vat_amount <= vat_amount),
  ADD CHECK (recoverability_reason IS NULL OR char_length(recoverability_reason) <= 500),
  ADD CHECK (
    (recoverability_status IN ('not_applicable', 'needs_review') AND recoverable_vat_amount IS NULL
      AND recoverability_reviewed_by_user_id IS NULL AND recoverability_reviewed_at IS NULL)
    OR
    (recoverability_status = 'fully_recoverable' AND recoverable_vat_amount = COALESCE(vat_amount, 0))
    OR
    (recoverability_status = 'non_recoverable' AND recoverable_vat_amount = 0)
    OR
    (recoverability_status = 'partially_recoverable' AND recoverable_vat_amount > 0 AND recoverable_vat_amount < vat_amount)
  );
