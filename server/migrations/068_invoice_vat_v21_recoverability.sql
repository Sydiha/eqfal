-- Migration 068: invoice VAT V2.1 (purchase input VAT recoverability). Structure only, no data rows are inserted or changed.
-- Owner policy (2026-10-12), expense purchases only (asset purchases stay unsupported): non-recoverable input VAT is capitalized into the
-- related expense cost; partially recoverable VAT is split (recoverable -> VAT_INPUT, non-recoverable -> the expense).
-- Recovery is never inferred. The creator states it per standard-rated purchase line: 'fully_recoverable' | 'non_recoverable' |
-- 'partially_recoverable' (+ an explicit percent, 0 < percent < 100, 2 decimals). The recoverable amount of a line is
-- ROUND_HALF_UP(vat_amount * percent / 100, 2) (same rule as the line-level rounding of the invoice math), 0 for non_recoverable, vat_amount for fully.
-- The immutable snapshot keeps its 067 columns; only their meaning widens: recoverable_vat_amount <= vat_amount (sum of explicit line recovery).
-- Rollback: restore check_invoice_vat_review() from 067; DROP FUNCTION line_recoverable; restore invoice_lines_recoverability_check and
--   invoice_vat_reviews_recoverable_check from 067; DROP COLUMN invoice_lines.vat_recoverable_percent.

ALTER TABLE invoice_lines ADD COLUMN vat_recoverable_percent NUMERIC(5,2);
ALTER TABLE invoice_lines DROP CONSTRAINT invoice_lines_recoverability_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_recoverability_check CHECK (
  (vat_recoverability IS NULL AND vat_recoverable_percent IS NULL)
  OR (vat_treatment = 'standard' AND (
        (vat_recoverability IN ('fully_recoverable', 'non_recoverable') AND vat_recoverable_percent IS NULL)
     OR (vat_recoverability = 'partially_recoverable' AND vat_recoverable_percent IS NOT NULL AND vat_recoverable_percent > 0 AND vat_recoverable_percent < 100))));

ALTER TABLE invoice_vat_reviews DROP CONSTRAINT invoice_vat_reviews_recoverable_check;
ALTER TABLE invoice_vat_reviews ADD CONSTRAINT invoice_vat_reviews_recoverable_check CHECK (
  (direction = 'sales' AND recoverable_vat_amount IS NULL)
  OR (direction = 'purchase' AND recoverable_vat_amount IS NOT NULL AND recoverable_vat_amount >= 0 AND recoverable_vat_amount <= vat_amount));

-- Recoverable VAT of one invoice line from its EXPLICIT statement only. NULL for sales; NULL (never a default) for a purchase
-- standard line without a coherent statement. Non-standard purchase lines carry no VAT, hence 0.
CREATE FUNCTION line_recoverable(direction TEXT, treatment TEXT, vat NUMERIC, recoverability TEXT, percent NUMERIC) RETURNS NUMERIC AS $$
  SELECT CASE
    WHEN direction <> 'purchase' THEN NULL
    WHEN treatment <> 'standard' THEN 0
    WHEN recoverability = 'fully_recoverable' THEN vat
    WHEN recoverability = 'non_recoverable' THEN 0
    WHEN recoverability = 'partially_recoverable' THEN ROUND(vat * percent / 100, 2)
  END
$$ LANGUAGE sql IMMUTABLE;

-- Exactness, checked at commit (replaces the 067 version; sales checks are unchanged). Purchases: every standard line carries an explicit
-- recovery, each group's recoverable amount equals the sum of its lines' explicit recovery, and the header equals the sum of its groups.
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
                 AND vat_recoverability IS NULL)
       OR EXISTS (SELECT 1 FROM invoice_vat_review_groups WHERE review_id = NEW.id AND company_id = NEW.company_id AND recoverable_vat_amount IS NULL) THEN
      RAISE EXCEPTION 'every standard-rated purchase line needs an explicit recoverability' USING ERRCODE = '23514';
    END IF;
    IF NEW.recoverable_vat_amount IS DISTINCT FROM (SELECT SUM(recoverable_vat_amount) FROM invoice_vat_review_groups WHERE review_id = NEW.id AND company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'the recoverable VAT of the review differs from the sum of its groups' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT COALESCE(SUM(taxable_amount),0), COALESCE(SUM(vat_amount),0) INTO grp_taxable, grp_vat
    FROM invoice_vat_review_groups WHERE review_id = NEW.id AND company_id = NEW.company_id;
  IF grp_taxable <> NEW.taxable_amount OR grp_vat <> NEW.vat_amount
     OR NEW.taxable_amount <> inv.subtotal_amount OR NEW.vat_amount <> inv.vat_amount THEN
    RAISE EXCEPTION 'VAT review totals differ from the invoice' USING ERRCODE = '23514';
  END IF;
  SELECT COUNT(*) INTO mismatch FROM (
    (SELECT vat_treatment, vat_rate, COUNT(*)::int AS line_count, SUM(net_amount) AS taxable_amount, SUM(vat_amount) AS vat_amount, SUM(line_recoverable(NEW.direction, vat_treatment, vat_amount, vat_recoverability, vat_recoverable_percent)) AS recoverable_vat_amount
       FROM invoice_lines WHERE invoice_id = NEW.invoice_id AND company_id = NEW.company_id GROUP BY vat_treatment, vat_rate
     EXCEPT
     SELECT vat_treatment, vat_rate, line_count, taxable_amount, vat_amount, recoverable_vat_amount FROM invoice_vat_review_groups WHERE review_id = NEW.id AND company_id = NEW.company_id)
    UNION ALL
    (SELECT vat_treatment, vat_rate, line_count, taxable_amount, vat_amount, recoverable_vat_amount FROM invoice_vat_review_groups WHERE review_id = NEW.id AND company_id = NEW.company_id
     EXCEPT
     SELECT vat_treatment, vat_rate, COUNT(*)::int, SUM(net_amount), SUM(vat_amount), SUM(line_recoverable(NEW.direction, vat_treatment, vat_amount, vat_recoverability, vat_recoverable_percent))
       FROM invoice_lines WHERE invoice_id = NEW.invoice_id AND company_id = NEW.company_id GROUP BY vat_treatment, vat_rate)
  ) diff;
  IF mismatch > 0 THEN RAISE EXCEPTION 'VAT review groups differ from the invoice lines' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
