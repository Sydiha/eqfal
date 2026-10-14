-- Migration 074: permission-based approval (owner decision 2026-10-14). A user who holds the explicit approval capabilities may approve,
-- including a record they created. This removes only the creator-identity blocks at the database level; every other guard stays.
--   * invoice_adjustments_separation_check (072) is dropped: the approver may be the registrant.
--   * check_invoice_vat_review() (068) keeps "the VAT review is made by the invoice approver" and drops "the approver is not the creator".
--     The rest of the function is unchanged from 068.
-- Structure only: no data rows are inserted or changed and no capability is granted to any role.
-- Rollback: re-add invoice_adjustments_separation_check from 072 and restore check_invoice_vat_review() from 068.
ALTER TABLE invoice_adjustments DROP CONSTRAINT IF EXISTS invoice_adjustments_separation_check;

CREATE OR REPLACE FUNCTION check_invoice_vat_review() RETURNS trigger AS $$
DECLARE inv RECORD; grp_taxable NUMERIC; grp_vat NUMERIC; mismatch INTEGER;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = NEW.invoice_id AND company_id = NEW.company_id;
  IF NOT FOUND OR inv.status <> 'approved' OR inv.direction <> NEW.direction THEN
    RAISE EXCEPTION 'a VAT review requires an approved invoice of the same direction' USING ERRCODE = '23514';
  END IF;
  IF inv.approved_by_user_id IS DISTINCT FROM NEW.reviewed_by_user_id THEN
    RAISE EXCEPTION 'the VAT review must be made by the invoice approver' USING ERRCODE = '23514';
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
