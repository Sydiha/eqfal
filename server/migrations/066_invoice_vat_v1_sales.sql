-- Migration 066: invoice VAT integration, V1 (sales invoices only). Structure only, no data rows are inserted or changed.
-- Owner direction 2026-10-09: explicit tax_point_date on the invoice and an explicit VAT treatment on every line (never inferred
-- from the VAT rate); the creator selects, the independent approver verifies; approval writes an immutable reviewed VAT snapshot
-- (header + one group per treatment and rate) in the same transaction. Purchases stay blocked until V2.
-- Existing rows are untouched: both new columns are nullable and are required only when a sales invoice is submitted/approved.
-- Rollback: DROP TABLE invoice_vat_review_groups, invoice_vat_reviews; DROP the three triggers/functions below; DROP the new columns.

ALTER TABLE invoices ADD COLUMN tax_point_date DATE;
ALTER TABLE invoice_lines ADD COLUMN vat_treatment TEXT CHECK (vat_treatment IN ('standard','zero_rated','exempt','out_of_scope'));
ALTER TABLE invoice_lines ADD COLUMN treatment_note TEXT CHECK (treatment_note IS NULL OR char_length(btrim(treatment_note)) BETWEEN 1 AND 500);
-- Coherence only (not a tax rule): a standard line carries a positive rate; every other treatment carries no VAT at all.
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_treatment_rate_check CHECK (
  vat_treatment IS NULL
  OR (vat_treatment = 'standard' AND vat_rate > 0)
  OR (vat_treatment <> 'standard' AND vat_rate = 0 AND vat_amount = 0));

CREATE TABLE invoice_vat_reviews (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id         UUID          NOT NULL,
  direction          TEXT          NOT NULL DEFAULT 'sales' CHECK (direction = 'sales'),
  tax_date           DATE          NOT NULL,
  taxable_amount     NUMERIC(18,2) NOT NULL CHECK (taxable_amount >= 0),
  vat_amount         NUMERIC(18,2) NOT NULL CHECK (vat_amount >= 0),
  reviewed_by_user_id UUID         NOT NULL REFERENCES users(id),
  reviewed_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (invoice_id),
  CONSTRAINT invoice_vat_reviews_invoice_fk FOREIGN KEY (invoice_id, company_id, direction) REFERENCES invoices(id, company_id, direction)
);
CREATE INDEX invoice_vat_reviews_company_tax_date_idx ON invoice_vat_reviews (company_id, tax_date);

CREATE TABLE invoice_vat_review_groups (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id      UUID          NOT NULL,
  vat_treatment  TEXT          NOT NULL CHECK (vat_treatment IN ('standard','zero_rated','exempt','out_of_scope')),
  vat_rate       NUMERIC(5,2)  NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
  line_count     INTEGER       NOT NULL CHECK (line_count > 0),
  taxable_amount NUMERIC(18,2) NOT NULL CHECK (taxable_amount >= 0),
  vat_amount     NUMERIC(18,2) NOT NULL CHECK (vat_amount >= 0),
  UNIQUE (review_id, vat_treatment, vat_rate),
  CONSTRAINT invoice_vat_review_groups_review_fk FOREIGN KEY (review_id, company_id) REFERENCES invoice_vat_reviews(id, company_id),
  CONSTRAINT invoice_vat_review_groups_treatment_check CHECK (
    (vat_treatment = 'standard' AND vat_rate > 0) OR (vat_treatment <> 'standard' AND vat_rate = 0 AND vat_amount = 0))
);

-- A reviewed VAT snapshot is immutable. Rows disappear only when the whole company is cascade-deleted.
CREATE FUNCTION guard_invoice_vat_snapshot() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'invoice VAT review snapshots are immutable' USING ERRCODE = '23514';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_vat_reviews_guard BEFORE UPDATE OR DELETE ON invoice_vat_reviews FOR EACH ROW EXECUTE FUNCTION guard_invoice_vat_snapshot();
CREATE TRIGGER invoice_vat_review_groups_guard BEFORE UPDATE OR DELETE ON invoice_vat_review_groups FOR EACH ROW EXECUTE FUNCTION guard_invoice_vat_snapshot();

-- Exactness, checked at commit: the snapshot must reproduce the invoice with no unexplained difference.
--   * the invoice is approved sales, reviewed by its approver, who is not its creator
--   * groups == the invoice lines grouped by (treatment, rate), amount for amount
--   * header taxable/VAT == sum of groups == invoice subtotal/VAT
CREATE FUNCTION check_invoice_vat_review() RETURNS trigger AS $$
DECLARE inv RECORD; grp_taxable NUMERIC; grp_vat NUMERIC; mismatch INTEGER;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = NEW.invoice_id AND company_id = NEW.company_id;
  IF NOT FOUND OR inv.status <> 'approved' OR inv.direction <> 'sales' THEN
    RAISE EXCEPTION 'a VAT review requires an approved sales invoice' USING ERRCODE = '23514';
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
CREATE CONSTRAINT TRIGGER invoice_vat_reviews_exact AFTER INSERT ON invoice_vat_reviews
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_invoice_vat_review();

-- No duplicate recognition between a document and the invoice it is linked to (the link is evidence only).
-- A document linked to a submitted or approved invoice can no longer receive a reviewed VAT review or a document obligation.
-- Documents already recognized stay exactly as they are; approval refuses to take over such a document (service-level check).
CREATE FUNCTION guard_linked_document_recognition() RETURNS trigger AS $$
DECLARE doc UUID;
BEGIN
  IF TG_TABLE_NAME = 'document_vat_reviews' THEN
    IF NEW.review_status <> 'reviewed' THEN RETURN NEW; END IF;
    doc := NEW.document_id;
  ELSE
    IF NEW.source_type <> 'document' OR NEW.document_id IS NULL THEN RETURN NEW; END IF;
    doc := NEW.document_id;
  END IF;
  IF EXISTS (SELECT 1 FROM invoice_source_links l JOIN invoices i ON i.id = l.invoice_id AND i.company_id = l.company_id
             WHERE l.document_id = doc AND l.company_id = NEW.company_id AND i.status IN ('submitted','approved')) THEN
    RAISE EXCEPTION 'the document is linked to an invoice that carries its VAT and obligation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER document_vat_reviews_linked_invoice_guard BEFORE INSERT OR UPDATE ON document_vat_reviews FOR EACH ROW EXECUTE FUNCTION guard_linked_document_recognition();
CREATE TRIGGER obligations_linked_invoice_guard BEFORE INSERT ON obligations FOR EACH ROW EXECUTE FUNCTION guard_linked_document_recognition();
