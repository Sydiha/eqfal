-- Migration 102: optional monthly closing policy per fiscal year.
-- 1) fiscal_years.monthly_close_policy ('required' | 'optional'), NOT NULL DEFAULT 'required'. Every existing row becomes 'required', so annual
--    closing behaves exactly as before until an authorised user selects 'optional' on an OPEN fiscal year.
-- 2) A trigger rejects any change of the policy once the fiscal year is closed (defence in depth; the service rejects it earlier with a stable code).
-- 3) Registers the capability fiscal_year.monthly_close_policy.manage ONLY. No role_capabilities row is inserted: no predefined role receives it;
--    Full Access holds it through the wildcard (075).
-- No monthly_close_periods, journal or fiscal-year status row is touched. Independent of the reserved migration 098.
-- Rollback (only while every fiscal year is 'required'): DROP TRIGGER fiscal_years_monthly_close_policy_lock ON fiscal_years;
--   DROP FUNCTION fiscal_years_monthly_close_policy_lock(); ALTER TABLE fiscal_years DROP COLUMN monthly_close_policy;
--   DELETE FROM capabilities WHERE id='fiscal_year.monthly_close_policy.manage';

ALTER TABLE fiscal_years
  ADD COLUMN monthly_close_policy TEXT NOT NULL DEFAULT 'required'
  CONSTRAINT fiscal_years_monthly_close_policy_check CHECK (monthly_close_policy IN ('required', 'optional'));

CREATE FUNCTION fiscal_years_monthly_close_policy_lock() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.monthly_close_policy IS DISTINCT FROM OLD.monthly_close_policy THEN
    RAISE EXCEPTION 'monthly_close_policy cannot change after the fiscal year is closed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fiscal_years_monthly_close_policy_lock
  BEFORE UPDATE OF monthly_close_policy ON fiscal_years
  FOR EACH ROW EXECUTE FUNCTION fiscal_years_monthly_close_policy_lock();

INSERT INTO capabilities (id) VALUES ('fiscal_year.monthly_close_policy.manage') ON CONFLICT (id) DO NOTHING;
