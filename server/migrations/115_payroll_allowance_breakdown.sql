-- Existing allowances have no known category. NULL marks rows created before this migration.
-- The original allowances amount remains the authoritative total for those rows.
ALTER TABLE payroll_draft_employees
  ADD COLUMN legacy_allowances NUMERIC(18,2),
  ADD COLUMN housing_allowance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (housing_allowance >= 0),
  ADD COLUMN transportation_allowance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (transportation_allowance >= 0),
  ADD COLUMN other_allowance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (other_allowance >= 0),
  ADD CONSTRAINT payroll_allowance_breakdown_check CHECK (
    legacy_allowances IS NULL AND housing_allowance = 0 AND transportation_allowance = 0 AND other_allowance = 0
    OR legacy_allowances IS NOT NULL AND legacy_allowances >= 0
      AND allowances = legacy_allowances + housing_allowance + transportation_allowance + other_allowance
  );
