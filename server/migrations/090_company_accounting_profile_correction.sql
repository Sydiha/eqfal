-- Approved accounting-profile correction: a controlled corrective version for the SAME effective period.
-- Lifecycle: the approved original stays approved (the only effective profile) until its corrective version is approved; the approval
-- supersedes the original and approves the corrective in one transaction. Nothing is edited in place and no row is deleted.
-- Approved profiles become immutable in the database: the only allowed UPDATEs are (a) shortening effective_to (ordinary future-version
-- approval) and (b) approved -> superseded. superseded rows are terminal.
-- Every reader filters workflow_status = 'approved', so superseded rows leave all consumers automatically.
-- PREREQUISITES: 025, 086 (company_accounting_profiles_cutover_guard keeps working: superseding / approving inside an active cut-over window is refused).
-- ROLLBACK (only while no superseded or corrective row exists; otherwise Owner approval is required because history would be lost):
--   DROP TRIGGER company_accounting_profiles_approved_immutable ON company_accounting_profiles;
--   DROP TRIGGER company_accounting_profiles_correction_frozen ON company_accounting_profiles;
--   DROP FUNCTION company_accounting_profiles_approved_immutable(); DROP FUNCTION company_accounting_profiles_correction_frozen();
--   DROP INDEX company_accounting_profiles_one_open_correction_uidx; DROP INDEX company_accounting_profiles_one_approved_per_start_uidx;
--   ALTER TABLE company_accounting_profiles DROP COLUMN corrects_profile_id, DROP COLUMN correction_reason, DROP COLUMN superseded_at, DROP COLUMN superseded_by_profile_id;
--   restore the original workflow_status CHECK from 025.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM company_accounting_profiles WHERE workflow_status = 'approved' GROUP BY company_id, effective_from HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Cannot add one-approved-profile-per-start index: duplicate approved profiles share a company and effective_from';
  END IF;
END $$;

ALTER TABLE company_accounting_profiles DROP CONSTRAINT company_accounting_profiles_workflow_status_check;
ALTER TABLE company_accounting_profiles ADD CONSTRAINT company_accounting_profiles_workflow_status_check
  CHECK (workflow_status IN ('draft', 'needs_review', 'reviewed', 'approved', 'superseded'));

ALTER TABLE company_accounting_profiles
  ADD COLUMN corrects_profile_id UUID,
  ADD COLUMN correction_reason TEXT,
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD COLUMN superseded_by_profile_id UUID;

ALTER TABLE company_accounting_profiles
  ADD CONSTRAINT company_accounting_profiles_corrects_fk FOREIGN KEY (corrects_profile_id, company_id) REFERENCES company_accounting_profiles (id, company_id),
  ADD CONSTRAINT company_accounting_profiles_superseded_by_fk FOREIGN KEY (superseded_by_profile_id, company_id) REFERENCES company_accounting_profiles (id, company_id),
  ADD CONSTRAINT company_accounting_profiles_correction_reason_check
    CHECK (corrects_profile_id IS NULL OR (correction_reason IS NOT NULL AND btrim(correction_reason) <> '')),
  ADD CONSTRAINT company_accounting_profiles_superseded_shape_check
    CHECK ((workflow_status = 'superseded') = (superseded_at IS NOT NULL AND superseded_by_profile_id IS NOT NULL)
       AND (workflow_status = 'superseded' OR (superseded_at IS NULL AND superseded_by_profile_id IS NULL))
       AND (workflow_status <> 'superseded' OR effective_from IS NOT NULL));

-- One open correction per original; one approved profile per (company, effective_from).
CREATE UNIQUE INDEX company_accounting_profiles_one_open_correction_uidx ON company_accounting_profiles (corrects_profile_id)
  WHERE corrects_profile_id IS NOT NULL AND workflow_status IN ('draft', 'needs_review', 'reviewed');
CREATE UNIQUE INDEX company_accounting_profiles_one_approved_per_start_uidx ON company_accounting_profiles (company_id, effective_from)
  WHERE workflow_status = 'approved';

-- Approved profiles are immutable; superseded profiles are terminal. DELETE is deliberately not guarded (companies ON DELETE CASCADE).
CREATE FUNCTION company_accounting_profiles_approved_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workflow_status = 'superseded' THEN
    RAISE EXCEPTION 'APPROVED_PROFILE_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'A superseded accounting profile cannot be changed';
  END IF;
  IF OLD.workflow_status <> 'approved' THEN RETURN NEW; END IF;
  -- (a) ordinary future-version approval: the period is only ever shortened.
  IF NEW.workflow_status = 'approved'
     AND NEW.effective_to IS NOT NULL AND (OLD.effective_to IS NULL OR NEW.effective_to < OLD.effective_to)
     AND (to_jsonb(NEW) - ARRAY['effective_to', 'updated_at']) = (to_jsonb(OLD) - ARRAY['effective_to', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  -- (b) correction: approved -> superseded with the superseding link, every other column unchanged.
  IF NEW.workflow_status = 'superseded'
     AND (to_jsonb(NEW) - ARRAY['workflow_status', 'superseded_at', 'superseded_by_profile_id', 'updated_at'])
       = (to_jsonb(OLD) - ARRAY['workflow_status', 'superseded_at', 'superseded_by_profile_id', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'APPROVED_PROFILE_IMMUTABLE' USING ERRCODE = '55000',
    DETAIL = 'An approved accounting profile cannot be edited in place; create a corrective version instead';
END $$;
CREATE TRIGGER company_accounting_profiles_approved_immutable BEFORE UPDATE ON company_accounting_profiles
  FOR EACH ROW EXECUTE FUNCTION company_accounting_profiles_approved_immutable();

-- A corrective version keeps the original's period, start date and currencies (the original is frozen, so the comparison is stable).
CREATE FUNCTION company_accounting_profiles_correction_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o company_accounting_profiles%ROWTYPE;
BEGIN
  IF NEW.corrects_profile_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO o FROM company_accounting_profiles WHERE id = NEW.corrects_profile_id AND company_id = NEW.company_id;
  IF NOT FOUND OR o.workflow_status NOT IN ('approved', 'superseded') THEN
    RAISE EXCEPTION 'CORRECTION_TARGET_INVALID' USING ERRCODE = '55000', DETAIL = 'A corrective version must correct an approved profile of the same company';
  END IF;
  IF NEW.effective_from IS DISTINCT FROM o.effective_from OR NEW.effective_to IS DISTINCT FROM o.effective_to
     OR NEW.first_live_accounting_date IS DISTINCT FROM o.first_live_accounting_date
     OR NEW.functional_currency IS DISTINCT FROM o.functional_currency OR NEW.reporting_currency IS DISTINCT FROM o.reporting_currency THEN
    RAISE EXCEPTION 'CORRECTION_FROZEN_FIELD' USING ERRCODE = '55000',
      DETAIL = 'A corrective version cannot change the effective dates, first live accounting date or currencies';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER company_accounting_profiles_correction_frozen BEFORE INSERT OR UPDATE ON company_accounting_profiles
  FOR EACH ROW EXECUTE FUNCTION company_accounting_profiles_correction_frozen();

-- Capability registration only (like 079/083/086): no role grant; Full Access holds it through the 075 wildcard.
INSERT INTO capabilities (id) VALUES ('company_accounting_profile.correct') ON CONFLICT (id) DO NOTHING;
