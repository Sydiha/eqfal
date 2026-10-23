-- Migration 092: internal numbering of credit / debit notes (Invoice VAT V3.2). Additive.
--   * invoice_adjustments.internal_number is allocated ONLY when a note is approved, per company + adjustment type + fiscal year.
--   * It never replaces external_number (the statutory identifier), which is untouched. Invoice numbering (062) is untouched.
--   * No backfill: notes approved before this migration keep internal_number NULL. No data rows are inserted or changed, no capability is granted.
-- Rollback: DROP TRIGGER invoice_adjustment_number_counters_guard; DROP FUNCTION allocate_adjustment_number, guard_adjustment_counter;
--   DROP TABLE invoice_adjustment_number_counters; DROP INDEX invoice_adjustments_internal_number_uidx;
--   ALTER TABLE invoice_adjustments DROP CONSTRAINT invoice_adjustments_internal_number_state_check, DROP CONSTRAINT invoice_adjustments_approved_internal_number_check, DROP COLUMN internal_number;
--   restore guard_invoice_adjustment() from 072 (approval_keys without 'internal_number').
ALTER TABLE invoice_adjustments ADD COLUMN internal_number BIGINT CHECK (internal_number > 0);
ALTER TABLE invoice_adjustments ADD CONSTRAINT invoice_adjustments_internal_number_state_check
  CHECK (internal_number IS NULL OR (status = 'approved' AND fiscal_year_id IS NOT NULL));
-- Every NEW approval carries a number. NOT VALID: notes approved before this migration keep NULL (no backfill); they are immutable, so they are never re-checked.
ALTER TABLE invoice_adjustments ADD CONSTRAINT invoice_adjustments_approved_internal_number_check
  CHECK (status <> 'approved' OR internal_number IS NOT NULL) NOT VALID;
CREATE UNIQUE INDEX invoice_adjustments_internal_number_uidx ON invoice_adjustments (company_id, adjustment_type, fiscal_year_id, internal_number) WHERE internal_number IS NOT NULL;

CREATE TABLE invoice_adjustment_number_counters (
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  adjustment_type TEXT        NOT NULL CHECK (adjustment_type IN ('credit','debit')),
  fiscal_year_id  UUID        NOT NULL,
  last_number     BIGINT      NOT NULL CHECK (last_number > 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, adjustment_type, fiscal_year_id),
  CONSTRAINT invoice_adjustment_number_counters_fiscal_year_fk FOREIGN KEY (fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE CASCADE
);

-- Same pattern as allocate_invoice_number(): the counter row lock is held until the caller's transaction ends, so concurrent approvals
-- serialize and a rolled-back approval does not consume a number.
CREATE FUNCTION allocate_adjustment_number(p_company_id UUID, p_adjustment_type TEXT, p_fiscal_year_id UUID) RETURNS BIGINT AS $$
  INSERT INTO invoice_adjustment_number_counters (company_id, adjustment_type, fiscal_year_id, last_number) VALUES (p_company_id, p_adjustment_type, p_fiscal_year_id, 1)
  ON CONFLICT (company_id, adjustment_type, fiscal_year_id) DO UPDATE SET last_number = invoice_adjustment_number_counters.last_number + 1, updated_at = NOW()
  RETURNING last_number;
$$ LANGUAGE sql;

CREATE FUNCTION guard_adjustment_counter() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'adjustment number counters cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.last_number < OLD.last_number THEN RAISE EXCEPTION 'adjustment number counters cannot decrease' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_adjustment_number_counters_guard BEFORE UPDATE OR DELETE ON invoice_adjustment_number_counters FOR EACH ROW EXECUTE FUNCTION guard_adjustment_counter();

-- guard_invoice_adjustment(): identical to 072 except that 'internal_number' is an approval column (draft -> approved may set it).
CREATE OR REPLACE FUNCTION guard_invoice_adjustment() RETURNS trigger AS $$
DECLARE
  meta_keys TEXT[] := ARRAY['updated_at','version'];
  approval_keys TEXT[] := ARRAY['status','approved_by_user_id','approved_at','fiscal_year_id','internal_number'];
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
