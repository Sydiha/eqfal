ALTER TABLE employee_bonus_entitlements
  ADD COLUMN award_code text NOT NULL DEFAULT 'standard'
    CHECK (award_code ~ '^[a-z0-9][a-z0-9_-]{0,49}$'),
  ADD CONSTRAINT employee_bonus_award_identity
    UNIQUE (company_id, employee_id, period_start, period_end, award_code);
