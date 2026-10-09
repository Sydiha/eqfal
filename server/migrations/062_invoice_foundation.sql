-- Migration 062: internal invoicing database foundation (PR-1). Purely additive.
-- Adds new tables only. No existing table, row, trigger or capability is touched.
-- Deliberately NOT included: invoice.* capabilities (deferred to a separate security review, because
-- Full Access roles resolve every registered capability dynamically), approval/posting logic,
-- recurring-invoice tables, ZATCA columns, API routes.
-- Recurring readiness: invoices carries origin / recurring_template_id / recurrence_occurrence_date so a
-- future template can generate drafts, with a unique index preventing duplicate generation per occurrence.

CREATE TABLE invoices (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  direction             TEXT          NOT NULL CHECK (direction IN ('sales','purchase')),
  status                TEXT          NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','cancelled')),
  counterparty_id       UUID          NOT NULL,
  fiscal_year_id        UUID,
  internal_number       BIGINT        CHECK (internal_number > 0),
  external_reference    TEXT          CHECK (external_reference IS NULL OR char_length(btrim(external_reference)) BETWEEN 1 AND 100),
  issue_date            DATE          NOT NULL,
  due_date              DATE,
  supply_date           DATE,
  currency              TEXT          NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
  subtotal_amount       NUMERIC(18,2) NOT NULL CHECK (subtotal_amount >= 0),
  vat_amount            NUMERIC(18,2) NOT NULL CHECK (vat_amount >= 0),
  total_amount          NUMERIC(18,2) NOT NULL CHECK (total_amount >= 0),
  notes                 TEXT,
  origin                TEXT          NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','recurring')),
  recurring_template_id UUID,
  recurrence_occurrence_date DATE,
  created_by_user_id    UUID          NOT NULL REFERENCES users(id),
  approved_by_user_id   UUID          REFERENCES users(id),
  approved_at           TIMESTAMPTZ,
  cancelled_by_user_id  UUID          REFERENCES users(id),
  cancelled_at          TIMESTAMPTZ,
  cancellation_reason   TEXT          CHECK (cancellation_reason IS NULL OR char_length(btrim(cancellation_reason)) BETWEEN 1 AND 500),
  version               INTEGER       NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (id, company_id, direction),
  CONSTRAINT invoices_fiscal_year_company_fk FOREIGN KEY (fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT invoices_counterparty_company_fk FOREIGN KEY (counterparty_id, company_id) REFERENCES counterparties(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT invoices_total_check CHECK (total_amount = subtotal_amount + vat_amount),
  CONSTRAINT invoices_due_date_check CHECK (due_date IS NULL OR due_date >= issue_date),
  -- Numbering scope is company + direction + fiscal year. Number, fiscal year and approval metadata exist together:
  -- always on approved invoices, never on draft/submitted ones, and preserved on an approved invoice that is later cancelled.
  CONSTRAINT invoices_numbering_fields_check CHECK ((internal_number IS NULL) = (fiscal_year_id IS NULL)),
  CONSTRAINT invoices_approval_fields_check CHECK (
    (approved_at IS NOT NULL) = (approved_by_user_id IS NOT NULL) AND (approved_at IS NOT NULL) = (internal_number IS NOT NULL)
    AND (status <> 'approved' OR approved_at IS NOT NULL)
    AND (status NOT IN ('draft','submitted') OR approved_at IS NULL)),
  CONSTRAINT invoices_cancellation_fields_check CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL AND cancellation_reason IS NOT NULL)
    AND (status = 'cancelled' OR (cancelled_at IS NULL AND cancelled_by_user_id IS NULL AND cancellation_reason IS NULL))),
  CONSTRAINT invoices_recurrence_fields_check CHECK ((origin = 'recurring') = (recurring_template_id IS NOT NULL AND recurrence_occurrence_date IS NOT NULL))
);
CREATE UNIQUE INDEX invoices_company_direction_fy_number_uidx ON invoices (company_id, direction, fiscal_year_id, internal_number) WHERE internal_number IS NOT NULL;
CREATE UNIQUE INDEX invoices_purchase_supplier_reference_uidx ON invoices (company_id, counterparty_id, external_reference) WHERE direction = 'purchase' AND external_reference IS NOT NULL;
CREATE UNIQUE INDEX invoices_recurrence_occurrence_uidx ON invoices (company_id, recurring_template_id, recurrence_occurrence_date) WHERE origin = 'recurring';
CREATE INDEX invoices_company_list_idx ON invoices (company_id, direction, status, issue_date DESC);

CREATE TABLE invoice_lines (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID          NOT NULL,
  invoice_id    UUID          NOT NULL,
  line_number   INTEGER       NOT NULL CHECK (line_number > 0),
  description   TEXT          NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
  quantity      NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price    NUMERIC(18,2) NOT NULL CHECK (unit_price >= 0),
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  vat_rate      NUMERIC(5,2)  NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
  net_amount    NUMERIC(18,2) NOT NULL CHECK (net_amount >= 0),
  vat_amount    NUMERIC(18,2) NOT NULL CHECK (vat_amount >= 0),
  total_amount  NUMERIC(18,2) NOT NULL CHECK (total_amount >= 0),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_id, line_number),
  CONSTRAINT invoice_lines_invoice_company_fk FOREIGN KEY (invoice_id, company_id) REFERENCES invoices(id, company_id) ON DELETE CASCADE,
  CONSTRAINT invoice_lines_total_check CHECK (total_amount = net_amount + vat_amount)
);

CREATE TABLE invoice_number_counters (
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  direction   TEXT        NOT NULL CHECK (direction IN ('sales','purchase')),
  fiscal_year_id UUID     NOT NULL,
  last_number BIGINT      NOT NULL CHECK (last_number > 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, direction, fiscal_year_id),
  CONSTRAINT invoice_number_counters_fiscal_year_fk FOREIGN KEY (fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE CASCADE
);

-- Atomically reserves the next number. The counter row lock is held until the caller's transaction ends,
-- so concurrent callers serialize and a rolled-back transaction does not consume a number.
CREATE FUNCTION allocate_invoice_number(p_company_id UUID, p_direction TEXT, p_fiscal_year_id UUID) RETURNS BIGINT AS $$
  INSERT INTO invoice_number_counters (company_id, direction, fiscal_year_id, last_number) VALUES (p_company_id, p_direction, p_fiscal_year_id, 1)
  ON CONFLICT (company_id, direction, fiscal_year_id) DO UPDATE SET last_number = invoice_number_counters.last_number + 1, updated_at = NOW()
  RETURNING last_number;
$$ LANGUAGE sql;

-- Credit / debit notes: separate adjustment records, never edits of the original invoice.
CREATE TABLE invoice_adjustments (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  original_invoice_id UUID          NOT NULL,
  direction           TEXT          NOT NULL CHECK (direction IN ('sales','purchase')),
  adjustment_type     TEXT          NOT NULL CHECK (adjustment_type IN ('credit','debit')),
  status              TEXT          NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','cancelled')),
  adjustment_date     DATE          NOT NULL,
  currency            TEXT          NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
  subtotal_amount     NUMERIC(18,2) NOT NULL CHECK (subtotal_amount >= 0),
  vat_amount          NUMERIC(18,2) NOT NULL CHECK (vat_amount >= 0),
  total_amount        NUMERIC(18,2) NOT NULL CHECK (total_amount > 0),
  reason              TEXT          NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  created_by_user_id  UUID          NOT NULL REFERENCES users(id),
  approved_by_user_id UUID          REFERENCES users(id),
  approved_at         TIMESTAMPTZ,
  version             INTEGER       NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  CONSTRAINT invoice_adjustments_original_fk FOREIGN KEY (original_invoice_id, company_id, direction) REFERENCES invoices(id, company_id, direction) ON DELETE RESTRICT,
  CONSTRAINT invoice_adjustments_total_check CHECK (total_amount = subtotal_amount + vat_amount),
  CONSTRAINT invoice_adjustments_approval_fields_check CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL))
);
CREATE INDEX invoice_adjustments_original_idx ON invoice_adjustments (company_id, original_invoice_id);

-- Optional link from an invoice to an uploaded document, as evidence only. A document supports one invoice.
-- The document FK cascades, but guard_invoice_children rejects removing a link of a non-draft invoice.
CREATE TABLE invoice_source_links (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID        NOT NULL,
  invoice_id         UUID        NOT NULL,
  document_id        UUID        NOT NULL,
  link_role          TEXT        NOT NULL DEFAULT 'evidence' CHECK (link_role = 'evidence'),
  created_by_user_id UUID        NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id),
  UNIQUE (invoice_id),
  CONSTRAINT invoice_source_links_invoice_fk FOREIGN KEY (invoice_id, company_id) REFERENCES invoices(id, company_id) ON DELETE CASCADE,
  CONSTRAINT invoice_source_links_document_fk FOREIGN KEY (document_id, company_id) REFERENCES documents(id, company_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------------------------
-- Immutability safeguards. A guard is skipped only while a company is being cascade-deleted
-- (the company row is already gone); the product never hard-deletes companies.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION guard_invoice_header() RETURNS trigger AS $$
DECLARE
  -- bookkeeping columns that may change on any update
  meta_keys TEXT[] := ARRAY['updated_at','version'];
  -- columns written only by the approval step / cancellation step
  approval_keys TEXT[] := ARRAY['status','internal_number','fiscal_year_id','approved_by_user_id','approved_at'];
  cancel_keys TEXT[] := ARRAY['status','cancelled_by_user_id','cancelled_at','cancellation_reason'];
  old_j JSONB; new_j JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN RETURN OLD; END IF;
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'only draft invoices can be deleted' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.direction <> OLD.direction OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'invoice identity columns are immutable' USING ERRCODE = '23514';
  END IF;
  old_j := to_jsonb(OLD); new_j := to_jsonb(NEW);
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled invoices are immutable' USING ERRCODE = '23514';
  ELSIF OLD.status = 'approved' THEN
    -- the only permitted change is cancellation, which adds cancellation metadata and keeps number and approval history
    IF NEW.status <> 'cancelled' OR (old_j - cancel_keys - meta_keys) <> (new_j - cancel_keys - meta_keys) THEN
      RAISE EXCEPTION 'approved invoices are immutable except for cancellation' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'submitted' THEN
    -- a submitted header cannot be materially altered; it must first be returned to draft
    IF NEW.status = 'submitted' THEN
      IF (old_j - meta_keys) <> (new_j - meta_keys) THEN RAISE EXCEPTION 'submitted invoices cannot be altered; return to draft first' USING ERRCODE = '23514'; END IF;
    ELSIF NEW.status = 'draft' THEN
      IF (old_j - meta_keys - 'status') <> (new_j - meta_keys - 'status') THEN RAISE EXCEPTION 'returning to draft cannot also alter the invoice' USING ERRCODE = '23514'; END IF;
    ELSIF NEW.status = 'approved' THEN
      IF (old_j - meta_keys - approval_keys) <> (new_j - meta_keys - approval_keys) THEN RAISE EXCEPTION 'approval cannot also alter the invoice' USING ERRCODE = '23514'; END IF;
    ELSIF NEW.status = 'cancelled' THEN
      IF (old_j - meta_keys - cancel_keys) <> (new_j - meta_keys - cancel_keys) THEN RAISE EXCEPTION 'cancellation cannot also alter the invoice' USING ERRCODE = '23514'; END IF;
    END IF;
  ELSIF NOT (NEW.status IN ('draft','submitted','cancelled')) THEN
    RAISE EXCEPTION 'invalid invoice status transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  ELSIF NEW.status = 'cancelled' AND (old_j - meta_keys - cancel_keys) <> (new_j - meta_keys - cancel_keys) THEN
    RAISE EXCEPTION 'cancellation cannot also alter the invoice' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION guard_invoice_header();

CREATE FUNCTION guard_invoice_children() RETURNS trigger AS $$
DECLARE target_invoice UUID; target_company UUID; parent_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.invoice_id <> OLD.invoice_id OR NEW.company_id <> OLD.company_id) THEN
    RAISE EXCEPTION 'invoice child parent cannot be changed' USING ERRCODE = '23514';
  END IF;
  target_invoice := COALESCE(NEW.invoice_id, OLD.invoice_id);
  target_company := COALESCE(NEW.company_id, OLD.company_id);
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM companies WHERE id = target_company) THEN RETURN OLD; END IF;
  SELECT status INTO parent_status FROM invoices WHERE id = target_invoice AND company_id = target_company;
  IF NOT FOUND THEN RETURN COALESCE(NEW, OLD); END IF;  -- parent being cascade-deleted (draft only) or FK check will reject
  IF parent_status <> 'draft' THEN
    RAISE EXCEPTION 'invoice lines and links are immutable unless the invoice is a draft' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION guard_invoice_children();
CREATE TRIGGER invoice_source_links_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_source_links FOR EACH ROW EXECUTE FUNCTION guard_invoice_children();

CREATE FUNCTION guard_invoice_adjustment() RETURNS trigger AS $$
BEGIN
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
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_adjustments_guard BEFORE UPDATE OR DELETE ON invoice_adjustments FOR EACH ROW EXECUTE FUNCTION guard_invoice_adjustment();

CREATE FUNCTION guard_invoice_counter() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'invoice number counters cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_number < OLD.last_number THEN RAISE EXCEPTION 'invoice number counters cannot decrease' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_number_counters_guard BEFORE UPDATE OR DELETE ON invoice_number_counters FOR EACH ROW EXECUTE FUNCTION guard_invoice_counter();
