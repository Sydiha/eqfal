-- Migration 073: recurring invoice templates (sales and purchase). Generates DRAFT invoices only.
-- Builds on 062 (invoices already carry origin / recurring_template_id / recurrence_occurrence_date, plus the unique index
-- invoices_recurrence_occurrence_uidx that makes one draft per template occurrence a database guarantee).
-- Structure only: no invoice or financial row is inserted, updated or deleted, and no capability is granted to any role.
--   * invoice.recurring is explicit-grant-only (implicit_full_access = FALSE): Full Access does not hold it.
--   * A template stores the raw line inputs (never amounts). Amounts, VAT and validation are recomputed by the normal draft path at generation.
--   * Generation never submits, approves, posts, settles or sends anything.
-- Rollback: ALTER TABLE invoices DROP CONSTRAINT invoices_recurring_template_fk; DROP TABLE recurring_invoice_template_lines, recurring_invoice_templates;
--   DELETE FROM capabilities WHERE id = 'invoice.recurring'.

INSERT INTO capabilities (id, implicit_full_access) VALUES ('invoice.recurring', FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access = FALSE;

CREATE TABLE recurring_invoice_templates (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  direction          TEXT         NOT NULL CHECK (direction IN ('sales','purchase')),
  name               TEXT         NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  counterparty_id    UUID         NOT NULL,
  frequency          TEXT         NOT NULL CHECK (frequency IN ('monthly','quarterly','annual')),
  start_date         DATE         NOT NULL,
  end_date           DATE,
  -- Day of month the schedule is anchored to; a short month clamps to its last day without drifting later occurrences (31 Jan -> 28 Feb -> 31 Mar).
  anchor_day         INTEGER      NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  next_run_date      DATE         NOT NULL,
  status             TEXT         NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  due_days           INTEGER      CHECK (due_days IS NULL OR due_days BETWEEN 0 AND 365),
  notes              TEXT         CHECK (notes IS NULL OR char_length(notes) <= 2000),
  last_generated_for DATE,
  last_attempt_at    TIMESTAMPTZ,
  last_error_code    TEXT,
  version            INTEGER      NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_user_id UUID         NOT NULL REFERENCES users(id),
  ended_by_user_id   UUID         REFERENCES users(id),
  ended_at           TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  CONSTRAINT recurring_templates_counterparty_fk FOREIGN KEY (counterparty_id, company_id) REFERENCES counterparties(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT recurring_templates_dates_check CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT recurring_templates_anchor_check CHECK (anchor_day = EXTRACT(DAY FROM start_date)),
  CONSTRAINT recurring_templates_next_run_check CHECK (next_run_date >= start_date),
  CONSTRAINT recurring_templates_end_fields_check CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);
CREATE INDEX recurring_templates_due_idx ON recurring_invoice_templates (next_run_date) WHERE status = 'active';
CREATE INDEX recurring_templates_company_idx ON recurring_invoice_templates (company_id, direction, status);

-- Raw line inputs, same shape and coherence rules as invoice_lines (062, 066-068); amounts are recomputed when a draft is generated.
CREATE TABLE recurring_invoice_template_lines (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID          NOT NULL,
  template_id             UUID          NOT NULL,
  line_number             INTEGER       NOT NULL CHECK (line_number > 0),
  description             TEXT          NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
  quantity                NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_price              NUMERIC(18,2) NOT NULL CHECK (unit_price >= 0),
  discount_amount         NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  vat_rate                NUMERIC(5,2)  NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
  vat_treatment           TEXT          CHECK (vat_treatment IS NULL OR vat_treatment IN ('standard','zero_rated','exempt','out_of_scope')),
  treatment_note          TEXT          CHECK (treatment_note IS NULL OR char_length(btrim(treatment_note)) BETWEEN 1 AND 500),
  vat_recoverability      TEXT          CHECK (vat_recoverability IS NULL OR vat_recoverability IN ('fully_recoverable','non_recoverable','partially_recoverable')),
  vat_recoverable_percent NUMERIC(5,2),
  UNIQUE (template_id, line_number),
  CONSTRAINT recurring_template_lines_template_fk FOREIGN KEY (template_id, company_id) REFERENCES recurring_invoice_templates(id, company_id) ON DELETE CASCADE,
  CONSTRAINT recurring_template_lines_recoverability_check CHECK (
    (vat_recoverability IS NULL AND vat_recoverable_percent IS NULL)
    OR (vat_treatment = 'standard' AND (
         (vat_recoverability IN ('fully_recoverable','non_recoverable') AND vat_recoverable_percent IS NULL)
      OR (vat_recoverability = 'partially_recoverable' AND vat_recoverable_percent > 0 AND vat_recoverable_percent < 100))))
);

-- A generated draft must belong to a real template of the SAME company. Existing rows are manual (NULL) and are not touched.
ALTER TABLE invoices
  ADD CONSTRAINT invoices_recurring_template_fk FOREIGN KEY (recurring_template_id, company_id)
  REFERENCES recurring_invoice_templates(id, company_id) ON DELETE RESTRICT;
