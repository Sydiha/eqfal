-- Migration 072 (F4 completion): registration of EXTERNALLY ISSUED credit / debit notes against approved invoices.
-- EQFAL is a financial management and closing system, not an e-invoicing issuer: a note is issued elsewhere and only REGISTERED here
-- (original invoice, external number, issue date, reason, amounts, VAT details, supporting document). Nothing is generated or sent.
-- Builds on 062 (invoice_adjustments), 065 (mappings, journal guards), 066-068 (VAT snapshots and recoverability). Structure only:
-- no data rows are inserted or changed, and no capability is granted to any role (both new permissions are explicit-grant-only).
--   * The original invoice, its obligation, its journal and its VAT snapshot are never touched. An approved note creates its OWN draft
--     journal (source_type 'invoice_adjustment'), posted through the normal journal posting flow.
--   * No new receivable/payable: the note adjusts the existing invoice obligation through obligation_adjustment_net().
--   * Settlement can never exceed original + approved debit notes - approved credit notes (trigger below).
-- Rollback: DROP TRIGGER/FUNCTION objects created here; restore guard_invoice_adjustment(), is_invoice_journal() and
--   guard_linked_document_recognition() from 062/065/066; DROP TABLE invoice_adjustment_source_links, invoice_adjustment_lines;
--   DROP the added invoice_adjustments columns/constraints/index; DELETE FROM capabilities WHERE id IN ('invoice.adjust','invoice.adjust_approve').

INSERT INTO capabilities (id, implicit_full_access) VALUES ('invoice.adjust', FALSE), ('invoice.adjust_approve', FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access = FALSE;

ALTER TABLE invoice_adjustments
  ADD COLUMN external_number      TEXT,
  ADD COLUMN counterparty_id      UUID,
  ADD COLUMN notes                TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  ADD COLUMN fiscal_year_id       UUID,
  ADD COLUMN cancelled_by_user_id UUID REFERENCES users(id),
  ADD COLUMN cancelled_at         TIMESTAMPTZ,
  ADD COLUMN cancellation_reason  TEXT CHECK (cancellation_reason IS NULL OR char_length(btrim(cancellation_reason)) BETWEEN 1 AND 500);
-- NOT VALID: the table had no creation path before this migration; the rules apply to every new or changed row.
ALTER TABLE invoice_adjustments
  ADD CONSTRAINT invoice_adjustments_external_number_check CHECK (external_number IS NOT NULL AND char_length(btrim(external_number)) BETWEEN 1 AND 100) NOT VALID,
  ADD CONSTRAINT invoice_adjustments_counterparty_required CHECK (counterparty_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT invoice_adjustments_counterparty_fk FOREIGN KEY (counterparty_id, company_id) REFERENCES counterparties(id, company_id) ON DELETE RESTRICT,
  ADD CONSTRAINT invoice_adjustments_fiscal_year_fk FOREIGN KEY (fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE RESTRICT,
  ADD CONSTRAINT invoice_adjustments_fiscal_year_check CHECK (status <> 'approved' OR fiscal_year_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT invoice_adjustments_cancel_fields_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND cancellation_reason IS NOT NULL)) NOT VALID,
  -- Separation of duties: the registrant of a note never approves it.
  ADD CONSTRAINT invoice_adjustments_separation_check CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> created_by_user_id) NOT VALID;
-- Duplicate registration: one external number per counterparty and direction, whatever the original invoice (cancelled drafts free the number).
CREATE UNIQUE INDEX invoice_adjustments_external_number_uidx ON invoice_adjustments (company_id, direction, counterparty_id, lower(btrim(external_number))) WHERE status <> 'cancelled';

-- Amount lines of the note exactly as printed on the external document: one (treatment, rate) amount per line.
-- Same coherence rules as invoice_lines (066-068); purchases state the input-VAT recovery explicitly, exactly like purchase invoices.
CREATE TABLE invoice_adjustment_lines (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  adjustment_id           UUID          NOT NULL,
  line_number             INTEGER       NOT NULL CHECK (line_number > 0),
  description             TEXT          NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
  vat_treatment           TEXT          NOT NULL CHECK (vat_treatment IN ('standard','zero_rated','exempt','out_of_scope')),
  treatment_note          TEXT          CHECK (treatment_note IS NULL OR char_length(btrim(treatment_note)) BETWEEN 1 AND 500),
  vat_rate                NUMERIC(5,2)  NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
  net_amount              NUMERIC(18,2) NOT NULL CHECK (net_amount > 0),
  vat_amount              NUMERIC(18,2) NOT NULL CHECK (vat_amount >= 0),
  total_amount            NUMERIC(18,2) NOT NULL,
  vat_recoverability      TEXT,
  vat_recoverable_percent NUMERIC(5,2),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (adjustment_id, line_number),
  CONSTRAINT invoice_adjustment_lines_adjustment_fk FOREIGN KEY (adjustment_id, company_id) REFERENCES invoice_adjustments(id, company_id) ON DELETE CASCADE,
  CONSTRAINT invoice_adjustment_lines_total_check CHECK (total_amount = net_amount + vat_amount),
  CONSTRAINT invoice_adjustment_lines_treatment_rate_check CHECK (
    (vat_treatment = 'standard' AND vat_rate > 0) OR (vat_treatment <> 'standard' AND vat_rate = 0 AND vat_amount = 0)),
  CONSTRAINT invoice_adjustment_lines_recoverability_check CHECK (
    (vat_recoverability IS NULL AND vat_recoverable_percent IS NULL)
    OR (vat_treatment = 'standard' AND (
          (vat_recoverability IN ('fully_recoverable', 'non_recoverable') AND vat_recoverable_percent IS NULL)
       OR (vat_recoverability = 'partially_recoverable' AND vat_recoverable_percent IS NOT NULL AND vat_recoverable_percent > 0 AND vat_recoverable_percent < 100))))
);

-- Optional supporting document, evidence only (like invoice_source_links). A document supports at most one invoice OR one note.
CREATE TABLE invoice_adjustment_source_links (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID        NOT NULL,
  adjustment_id      UUID        NOT NULL,
  document_id        UUID        NOT NULL,
  created_by_user_id UUID        NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id),
  UNIQUE (adjustment_id),
  CONSTRAINT invoice_adjustment_source_links_adjustment_fk FOREIGN KEY (adjustment_id, company_id) REFERENCES invoice_adjustments(id, company_id) ON DELETE CASCADE,
  CONSTRAINT invoice_adjustment_source_links_document_fk FOREIGN KEY (document_id, company_id) REFERENCES documents(id, company_id) ON DELETE CASCADE
);

CREATE FUNCTION guard_invoice_adjustment_children() RETURNS trigger AS $$
DECLARE target UUID; target_company UUID; parent_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.adjustment_id <> OLD.adjustment_id OR NEW.company_id <> OLD.company_id) THEN
    RAISE EXCEPTION 'adjustment child parent cannot be changed' USING ERRCODE = '23514';
  END IF;
  target := COALESCE(NEW.adjustment_id, OLD.adjustment_id);
  target_company := COALESCE(NEW.company_id, OLD.company_id);
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM companies WHERE id = target_company) THEN RETURN OLD; END IF;
  SELECT status INTO parent_status FROM invoice_adjustments WHERE id = target AND company_id = target_company;
  IF NOT FOUND THEN RETURN COALESCE(NEW, OLD); END IF;  -- parent being cascade-deleted (draft only) or FK check will reject
  IF parent_status <> 'draft' THEN
    RAISE EXCEPTION 'adjustment lines and links are immutable unless the adjustment is a draft' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_adjustment_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_adjustment_lines FOR EACH ROW EXECUTE FUNCTION guard_invoice_adjustment_children();
CREATE TRIGGER invoice_adjustment_source_links_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_adjustment_source_links FOR EACH ROW EXECUTE FUNCTION guard_invoice_adjustment_children();

-- A document is evidence for one invoice OR one note, never both.
CREATE FUNCTION guard_adjustment_link_exclusive() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'invoice_adjustment_source_links' THEN
    IF EXISTS (SELECT 1 FROM invoice_source_links WHERE document_id = NEW.document_id) THEN
      RAISE EXCEPTION 'the document is already linked to an invoice' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM invoice_adjustment_source_links WHERE document_id = NEW.document_id) THEN
    RAISE EXCEPTION 'the document is already linked to a credit or debit note' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_adjustment_links_exclusive BEFORE INSERT ON invoice_adjustment_source_links FOR EACH ROW EXECUTE FUNCTION guard_adjustment_link_exclusive();
CREATE TRIGGER invoice_links_exclusive BEFORE INSERT ON invoice_source_links FOR EACH ROW EXECUTE FUNCTION guard_adjustment_link_exclusive();

-- Header immutability. Drafts are editable; draft -> approved changes only approval columns, draft -> cancelled only cancellation columns.
-- Approved and cancelled notes never change again. New notes always start as drafts.
CREATE OR REPLACE FUNCTION guard_invoice_adjustment() RETURNS trigger AS $$
DECLARE
  meta_keys TEXT[] := ARRAY['updated_at','version'];
  approval_keys TEXT[] := ARRAY['status','approved_by_user_id','approved_at','fiscal_year_id'];
  cancel_keys TEXT[] := ARRAY['status','cancelled_by_user_id','cancelled_at','cancellation_reason'];
  old_j JSONB; new_j JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'a note is registered as a draft' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN RETURN OLD; END IF;
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'only draft adjustments can be deleted' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('approved','cancelled') THEN
    RAISE EXCEPTION 'approved or cancelled adjustments are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.original_invoice_id <> OLD.original_invoice_id
     OR NEW.direction <> OLD.direction OR NEW.adjustment_type <> OLD.adjustment_type THEN
    RAISE EXCEPTION 'adjustment identity columns are immutable' USING ERRCODE = '23514';
  END IF;
  old_j := to_jsonb(OLD); new_j := to_jsonb(NEW);
  IF NEW.status = 'approved' AND (old_j - meta_keys - approval_keys) <> (new_j - meta_keys - approval_keys) THEN
    RAISE EXCEPTION 'approval cannot also alter the adjustment' USING ERRCODE = '23514';
  ELSIF NEW.status = 'cancelled' AND (old_j - meta_keys - cancel_keys) <> (new_j - meta_keys - cancel_keys) THEN
    RAISE EXCEPTION 'cancellation cannot also alter the adjustment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_adjustments_insert_guard BEFORE INSERT ON invoice_adjustments FOR EACH ROW EXECUTE FUNCTION guard_invoice_adjustment();

-- Exactness, checked at commit when a note becomes approved: lines reproduce the header, the original invoice is an approved invoice of
-- the same direction and counterparty that is not newer than the note, purchases state recoverability on every standard line, sales on none,
-- and the note's own journal exists. (Caps against the original invoice, VAT periods and outstanding balance are service rules under row locks.)
CREATE FUNCTION check_invoice_adjustment_exact() RETURNS trigger AS $$
DECLARE inv RECORD; sums RECORD;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = NEW.original_invoice_id AND company_id = NEW.company_id;
  IF NOT FOUND OR inv.status <> 'approved' OR inv.direction <> NEW.direction OR inv.counterparty_id <> NEW.counterparty_id THEN
    RAISE EXCEPTION 'a note requires an approved invoice of the same direction and counterparty' USING ERRCODE = '23514';
  END IF;
  IF NEW.adjustment_date < inv.issue_date THEN
    RAISE EXCEPTION 'a note cannot be dated before its original invoice' USING ERRCODE = '23514';
  END IF;
  SELECT COUNT(*) AS n, COALESCE(SUM(net_amount),0) AS net, COALESCE(SUM(vat_amount),0) AS vat INTO sums
    FROM invoice_adjustment_lines WHERE adjustment_id = NEW.id AND company_id = NEW.company_id;
  IF sums.n = 0 OR sums.net <> NEW.subtotal_amount OR sums.vat <> NEW.vat_amount THEN
    RAISE EXCEPTION 'adjustment lines differ from the adjustment totals' USING ERRCODE = '23514';
  END IF;
  IF NEW.direction = 'sales' AND EXISTS (SELECT 1 FROM invoice_adjustment_lines WHERE adjustment_id = NEW.id AND company_id = NEW.company_id AND vat_recoverability IS NOT NULL) THEN
    RAISE EXCEPTION 'sales VAT has no recoverability' USING ERRCODE = '23514';
  END IF;
  IF NEW.direction = 'purchase' AND EXISTS (SELECT 1 FROM invoice_adjustment_lines WHERE adjustment_id = NEW.id AND company_id = NEW.company_id AND vat_treatment = 'standard' AND vat_recoverability IS NULL) THEN
    RAISE EXCEPTION 'every standard-rated purchase note line needs an explicit recoverability' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE company_id = NEW.company_id AND source_type = 'invoice_adjustment' AND source_id = NEW.id) THEN
    RAISE EXCEPTION 'an approved note needs its own journal' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER invoice_adjustments_exact AFTER UPDATE ON invoice_adjustments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'approved' AND OLD.status = 'draft') EXECUTE FUNCTION check_invoice_adjustment_exact();

-- Net effect (credit -, debit +) of APPROVED notes on an invoice-backed obligation; 0 for every other obligation. Optional as-of date for reports.
CREATE FUNCTION obligation_adjustment_net(p_obligation UUID, p_company UUID, p_as_of DATE DEFAULT NULL) RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(CASE a.adjustment_type WHEN 'debit' THEN a.total_amount ELSE -a.total_amount END), 0)
  FROM obligations o JOIN invoice_adjustments a ON a.original_invoice_id = o.invoice_id AND a.company_id = o.company_id AND a.status = 'approved'
  WHERE o.id = p_obligation AND o.company_id = p_company AND o.source_type = 'invoice' AND (p_as_of IS NULL OR a.adjustment_date <= p_as_of);
$$ LANGUAGE sql STABLE;

-- Settlement can never exceed the adjusted amount (original + approved debit notes - approved credit notes). Settlement already serializes on the
-- obligation row, and note approval locks the same row, so a credit note can never be approved over money already collected/paid.
CREATE FUNCTION guard_invoice_obligation_adjusted_settlement() RETURNS trigger AS $$
DECLARE ob RECORD; prior NUMERIC;
BEGIN
  SELECT original_amount, source_type INTO ob FROM obligations WHERE id = NEW.obligation_id AND company_id = NEW.company_id;
  IF NOT FOUND OR ob.source_type <> 'invoice' THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO prior FROM obligation_settlements WHERE obligation_id = NEW.obligation_id AND company_id = NEW.company_id AND id <> NEW.id;
  IF prior + NEW.amount > ob.original_amount + obligation_adjustment_net(NEW.obligation_id, NEW.company_id) THEN
    RAISE EXCEPTION 'settlement exceeds the adjusted invoice amount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_obligation_adjusted_settlement_guard BEFORE INSERT OR UPDATE ON obligation_settlements FOR EACH ROW EXECUTE FUNCTION guard_invoice_obligation_adjusted_settlement();

-- Note journals get the same protection as invoice journals (065): lines are generated by approval only and are immutable except memo.
CREATE OR REPLACE FUNCTION is_invoice_journal(p_journal UUID, p_company UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM journal_entries j JOIN obligations o ON o.id = j.source_id AND o.company_id = j.company_id
                 WHERE j.id = p_journal AND j.company_id = p_company AND j.source_type = 'obligation' AND o.source_type = 'invoice')
      OR EXISTS (SELECT 1 FROM journal_entries j JOIN invoice_adjustments a ON a.id = j.source_id AND a.company_id = j.company_id
                 WHERE j.id = p_journal AND j.company_id = p_company AND j.source_type = 'invoice_adjustment');
$$ LANGUAGE sql STABLE;

-- A document linked to an approved note carries that note's evidence: it can no longer be recognized on its own (same rule as 066 for invoices).
CREATE OR REPLACE FUNCTION guard_linked_document_recognition() RETURNS trigger AS $$
DECLARE doc UUID;
BEGIN
  IF TG_TABLE_NAME = 'document_vat_reviews' THEN
    IF NEW.review_status <> 'reviewed' THEN RETURN NEW; END IF;
    doc := NEW.document_id;
  ELSIF TG_TABLE_NAME = 'custody_document_allocations' THEN
    doc := NEW.document_id;
  ELSE
    IF NEW.source_type <> 'document' OR NEW.document_id IS NULL THEN RETURN NEW; END IF;
    doc := NEW.document_id;
  END IF;
  IF EXISTS (SELECT 1 FROM invoice_source_links l JOIN invoices i ON i.id = l.invoice_id AND i.company_id = l.company_id
             WHERE l.document_id = doc AND l.company_id = NEW.company_id AND i.status IN ('submitted','approved'))
     OR EXISTS (SELECT 1 FROM invoice_adjustment_source_links l JOIN invoice_adjustments a ON a.id = l.adjustment_id AND a.company_id = l.company_id
             WHERE l.document_id = doc AND l.company_id = NEW.company_id AND a.status = 'approved') THEN
    RAISE EXCEPTION 'the document is linked to an invoice or note that carries its VAT and obligation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
