-- Migration 069: effective-dated standard VAT rates per jurisdiction (read-only reference data).
-- Scope is deliberately minimal: not a tax engine. Ordinary standard-rated supplies only; historical transitional
-- exceptions are NOT modelled and must be handled outside this table. Changes to rows require an owner-approved migration.
-- Rollback: DROP TABLE vat_standard_rates; DROP FUNCTION guard_vat_standard_rate_overlap();

CREATE TABLE vat_standard_rates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction   TEXT          NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  rate           NUMERIC(5,2)  NOT NULL CHECK (rate > 0 AND rate <= 100),
  effective_from DATE          NOT NULL,
  effective_to   DATE,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT vat_standard_rates_period_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT vat_standard_rates_start_unique UNIQUE (jurisdiction, effective_from)
);

-- Non-overlapping periods per jurisdiction (trigger instead of an exclusion constraint: no btree_gist dependency).
CREATE FUNCTION guard_vat_standard_rate_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('vat_standard_rates:' || NEW.jurisdiction, 0));
  IF EXISTS (
    SELECT 1 FROM vat_standard_rates r
    WHERE r.jurisdiction = NEW.jurisdiction AND r.id <> NEW.id
      AND r.effective_from <= COALESCE(NEW.effective_to, DATE '9999-12-31')
      AND NEW.effective_from <= COALESCE(r.effective_to, DATE '9999-12-31')
  ) THEN
    RAISE EXCEPTION 'VAT standard rate periods must not overlap';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER vat_standard_rates_no_overlap BEFORE INSERT OR UPDATE ON vat_standard_rates
  FOR EACH ROW EXECUTE FUNCTION guard_vat_standard_rate_overlap();

INSERT INTO vat_standard_rates (jurisdiction, rate, effective_from, effective_to) VALUES
  ('SA', 5.00,  DATE '2018-01-01', DATE '2020-06-30'),
  ('SA', 15.00, DATE '2020-07-01', NULL);
