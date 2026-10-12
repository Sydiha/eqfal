-- Migration 067: invoice VAT integration, V2 (purchase invoices). Structure only, no data rows are inserted or changed.
-- Builds on 066 without redesigning it: the same immutable reviewed snapshot (header + one group per treatment and rate) now also
-- covers purchase invoices, whose VAT is input VAT (VAT_INPUT, asset debit).
-- Input VAT recovery is never inferred. The creator states it explicitly on every standard-rated purchase line and the independent
-- approver verifies it. V2 supports only 'fully_recoverable': where non-recoverable or partially recoverable VAT is booked is an
-- owner policy decision that is not established in the repository, so those values are not accepted until it is made.
-- Sales snapshots keep exactly their V1 shape (recoverable columns stay NULL for sales).
-- Rollback: restore check_invoice_vat_review() from 066; DROP CONSTRAINT invoice_lines_recoverability_check,
--   invoice_vat_reviews_recoverable_check, invoice_vat_review_groups_recoverable_check; DROP the new columns; restore
--   invoice_vat_reviews_direction_check as CHECK (direction = 'sales').

ALTER TABLE invoice_lines ADD COLUMN vat_recoverability TEXT;
-- Coherence only: recoverability exists only on standard-rated lines, and only 'fully_recoverable' is supported (see header).
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_recoverability_check CHECK (
  vat_recoverability IS NULL OR (vat_recoverability = 'fully_recoverable' AND vat_treatment = 'standard'));

ALTER TABLE invoice_vat_reviews DROP CONSTRAINT invoice_vat_reviews_direction_check;
ALTER TABLE invoice_vat_reviews ADD CONSTRAINT invoice_vat_reviews_direction_check CHECK (direction IN ('sales','purchase'));
ALTER TABLE invoice_vat_reviews ADD COLUMN recoverable_vat_amount NUMERIC(18,2);
ALTER TABLE invoice_vat_reviews ADD CONSTRAINT invoice_vat_reviews_recoverable_check CHECK (
  (direction = 'sales' AND recoverable_vat_amount IS NULL)
  OR (direction = 'purchase' AND recoverable_vat_amount IS NOT NULL AND recoverable_vat_amount = vat_amount));

ALTER TABLE invoice_vat_review_groups ADD COLUMN recoverable_vat_amount NUMERIC(18,2);
ALTER TABLE invoice_vat_review_groups ADD CONSTRAINT invoice_vat_review_groups_recoverable_check CHECK (
  recoverable_vat_amount IS NULL OR (recoverable_vat_amount >= 0 AND recoverable_vat_amount <= vat_amount));

-- Exactness, checked at commit (replaces the 066 version; sales checks are unchanged):
--   * the invoice is approved, of the review's direction, reviewed by its approver, who is not its creator
--   * groups == the invoice lines grouped by (treatment, rate), amount for amount
--   * header taxable/VAT == sum of groups == invoice subtotal/VAT
--   * sales: no recoverability anywhere. purchase: every standard line explicitly fully recoverable, and recoverable == VAT
--     on every group and on the header.
CREATE OR REPLACE FUNCTION check_invoice_vat_review() RETURNS trigger AS $$
DECLARE inv RECORD; grp_taxable NUMERIC; grp_vat NUMERIC; mismatch INTEGER;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = NEW.invoice_id AND company_id = NEW.company_id;
  IF NOT FOUND OR inv.status <> 'approved' OR inv.direction <> NEW.direction THEN
    RAISE EXCEPTION 'a VAT review requires an approved invoice of the same direction' USING ERRCODE = '23514';
  END IF;
  IF inv.approved_by_user_id IS DISTINCT FROM NEW.reviewed_by_user_id OR NEW.reviewed_by_user_id = inv.created_by_user_id THEN
    RAISE EXCEPTION 'the VAT review must be made by the independent approver' USING ERRCODE = '23514';
  END IF;
  IF inv.tax_point_date IS DISTINCT FROM NEW.tax_date THEN
    RAISE EXCEPTION 'the VAT review tax date must equal the invoice tax point date' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.invoice_id AND company_id = NEW.company_id AND vat_treatment IS NULL) THEN
    RAISE EXCEPTION 'every invoice line needs an explicit VAT treatment' USING ERRCODE = '23514';
  END IF;
  IF NEW.direction = 'sales' THEN
    IF EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.invoice_id AND company_id = NEW.company_id AND vat_recoverability IS NOT NULL)
       OR EXISTS (SELECT 1 FROM invoice_vat_review_groups WHERE review_id = NEW.id AND company_id = NEW.company_id AND recoverable_vat_amount IS NOT NULL) THEN
      RAISE EXCEPTION 'sales VAT has no recoverability' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM invoice_lines WHERE invoice_id = NEW.invoice_id AND company_id = NEW.company_id AND vat_treatment = 'standard'
                 AND vat_recoverability IS DISTINCT FROM 'fully_recoverable')
       OR EXISTS (SELECT 1 FROM invoice_vat_review_groups WHERE review_id = NEW.id AND company_id = NEW.company_id
                    AND recoverable_vat_amount IS DISTINCT FROM vat_amount) THEN
      RAISE EXCEPTION 'every standard-rated purchase line needs an explicit supported recoverability' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT COALESCE(SUM(taxable_amount),0), COALESCE(SUM(vat_amount),0) INTO grp_taxable, grp_vat
    FROM invoice_vat_review_groups WHERE review_id = NEW.id AND company_id = NEW.company_id;
  IF grp_taxable <> NEW.taxable_amount OR grp_vat <> NEW.vat_amount
     OR NEW.taxable_amount <> inv.subtotal_amount OR NEW.vat_amount <> inv.vat_amount THEN
    RAISE EXCEPTION 'VAT review totals differ from the invoice' USING ERRCODE = '23514';
  END IF;
  SELECT COUNT(*) INTO mismatch FROM (
    (SELECT vat_treatment, vat_rate, COUNT(*)::int AS line_count, SUM(net_amount) AS taxable_amount, SUM(vat_amount) AS vat_amount
       FROM invoice_lines WHERE invoice_id = NEW.invoice_id AND company_id = NEW.company_id GROUP BY vat_treatment, vat_rate
     EXCEPT
     SELECT vat_treatment, vat_rate, line_count, taxable_amount, vat_amount FROM invoice_vat_review_groups WHERE review_id = NEW.id AND company_id = NEW.company_id)
    UNION ALL
    (SELECT vat_treatment, vat_rate, line_count, taxable_amount, vat_amount FROM invoice_vat_review_groups WHERE review_id = NEW.id AND company_id = NEW.company_id
     EXCEPT
     SELECT vat_treatment, vat_rate, COUNT(*)::int, SUM(net_amount), SUM(vat_amount)
       FROM invoice_lines WHERE invoice_id = NEW.invoice_id AND company_id = NEW.company_id GROUP BY vat_treatment, vat_rate)
  ) diff;
  IF mismatch > 0 THEN RAISE EXCEPTION 'VAT review groups differ from the invoice lines' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
