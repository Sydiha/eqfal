-- Company administrators may only manage reviewer appointments after an explicit System Admin delegation.
INSERT INTO capabilities(id,implicit_full_access) VALUES ('zakat.reviewer.manage',FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access=FALSE;

-- Convert the original one-row-per-reviewer registry into immutable appointment identities.
ALTER TABLE zakat_regulatory_reviewers
  ADD COLUMN appointment_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN appointed_by_user_id uuid REFERENCES users(id),
  ADD COLUMN identity_verified_at timestamptz,
  ADD COLUMN revoked_by_user_id uuid REFERENCES users(id),
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revocation_reason text;

-- The legacy registry has no identity verification provenance. Keep its rows for history, but invalidate them so
-- they cannot block a verified new appointment or authorize an existing decision.
UPDATE zakat_regulatory_reviewers
SET revoked_at=now(), revocation_reason='Invalidated during migration because the legacy appointment has no identity verification record';

ALTER TABLE zakat_regulatory_reviewers DROP CONSTRAINT zakat_regulatory_reviewers_pkey;
ALTER TABLE zakat_regulatory_reviewers ADD CONSTRAINT zakat_regulatory_reviewers_pkey PRIMARY KEY(company_id, appointment_id);
ALTER TABLE zakat_regulatory_reviewers ADD CONSTRAINT zakat_reviewer_appointment_scope_unique UNIQUE(company_id, user_id, appointment_id);
CREATE UNIQUE INDEX zakat_reviewer_one_active_idx ON zakat_regulatory_reviewers(company_id, user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX zakat_reviewer_appointment_id_idx ON zakat_regulatory_reviewers(appointment_id);
ALTER TABLE zakat_regulatory_reviewers ADD CONSTRAINT zakat_reviewer_revocation_complete CHECK (
  (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
  OR (revoked_at IS NOT NULL AND length(btrim(revocation_reason)) > 0)
);

-- Bind every historical decision to the precise appointment that reviewed it.
ALTER TABLE zakat_regulatory_decisions ADD COLUMN reviewer_appointment_id uuid;
-- Allow the one-time backfill while replacing the legacy immutable-row guard with one aware of the new field.
DROP TRIGGER zakat_regulatory_decision_guard ON zakat_regulatory_decisions;
UPDATE zakat_regulatory_decisions d SET reviewer_appointment_id=a.appointment_id
FROM zakat_regulatory_reviewers a
WHERE d.company_id=a.company_id AND d.reviewed_by=a.user_id AND d.reviewer_appointment=a.appointment_reference;
ALTER TABLE zakat_regulatory_decisions ADD CONSTRAINT zakat_decision_reviewer_appointment_fk
  FOREIGN KEY(company_id, reviewed_by, reviewer_appointment_id)
  REFERENCES zakat_regulatory_reviewers(company_id, user_id, appointment_id);

CREATE FUNCTION guard_zakat_regulatory_reviewer_appointment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Zakat reviewer appointment history is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.identity_verified_at IS NULL OR NEW.appointed_by_user_id IS NULL
      OR NEW.appointed_by_user_id=NEW.user_id
      OR NOT EXISTS (SELECT 1 FROM users u JOIN memberships m ON m.user_id=u.id AND m.company_id=NEW.company_id AND m.is_active
                     WHERE u.id=NEW.user_id AND u.is_active AND NOT u.is_system_admin)
      OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id=NEW.appointed_by_user_id AND u.is_active) THEN
      RAISE EXCEPTION 'Active company member and independent identity verification required' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.appointment_id IS DISTINCT FROM NEW.appointment_id
    OR OLD.company_id IS DISTINCT FROM NEW.company_id OR OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.appointment_reference IS DISTINCT FROM NEW.appointment_reference
    OR OLD.appointed_by_user_id IS DISTINCT FROM NEW.appointed_by_user_id
    OR OLD.identity_verified_at IS DISTINCT FROM NEW.identity_verified_at
    OR OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL OR NEW.revoked_by_user_id IS NULL OR length(btrim(NEW.revocation_reason))=0 THEN
    RAISE EXCEPTION 'Appointments are immutable; revoke once and create a new identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zakat_regulatory_decision_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zakat_regulatory_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_zakat_regulatory_decision();
CREATE TRIGGER zakat_reviewer_appointment_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zakat_regulatory_reviewers
  FOR EACH ROW EXECUTE FUNCTION guard_zakat_regulatory_reviewer_appointment();
CREATE TRIGGER zakat_reviewer_appointment_truncate_guard BEFORE TRUNCATE ON zakat_regulatory_reviewers
  FOR EACH STATEMENT EXECUTE FUNCTION guard_zakat_regulatory_reviewer_appointment();

-- An approval is valid only for its exact, currently active, verified appointment.
CREATE OR REPLACE FUNCTION guard_zakat_regulatory_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM zakat_regulatory_decisions) THEN
      RAISE EXCEPTION 'Zakat regulatory decision history is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Zakat regulatory decision history is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.reviewed_by IS NOT NULL OR NEW.reviewer_appointment_id IS NOT NULL OR NEW.ended_by IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM zakat_worksheets w WHERE w.id=NEW.worksheet_id AND w.company_id=NEW.company_id
        AND w.fiscal_year_id=NEW.fiscal_year_id
    ) THEN
      RAISE EXCEPTION 'Zakat decisions must start pending and match the worksheet period' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.ended_at IS NOT NULL OR
    (to_jsonb(OLD) - ARRAY['reviewed_by','reviewer_appointment','reviewer_appointment_id','approved_at','ended_by','ended_at','end_reason'])
      IS DISTINCT FROM
    (to_jsonb(NEW) - ARRAY['reviewed_by','reviewer_appointment','reviewer_appointment_id','approved_at','ended_by','ended_at','end_reason']) THEN
    RAISE EXCEPTION 'Zakat regulatory decision history is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.reviewed_by, OLD.reviewer_appointment, OLD.reviewer_appointment_id, OLD.approved_at)
     IS DISTINCT FROM (NEW.reviewed_by, NEW.reviewer_appointment, NEW.reviewer_appointment_id, NEW.approved_at) THEN
    IF OLD.reviewed_by IS NOT NULL OR NEW.ended_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM zakat_regulatory_reviewers a JOIN users u ON u.id=a.user_id AND u.is_active
      JOIN memberships m ON m.user_id=a.user_id AND m.company_id=a.company_id AND m.is_active
      JOIN documents e ON e.id=NEW.evidence_document_id AND e.company_id=a.company_id
      JOIN zakat_worksheets w ON w.id=NEW.worksheet_id AND w.company_id=a.company_id
      WHERE a.company_id=NEW.company_id AND a.user_id=NEW.reviewed_by
        AND a.appointment_id=NEW.reviewer_appointment_id AND a.appointment_reference=NEW.reviewer_appointment
        AND a.identity_verified_at IS NOT NULL AND a.revoked_at IS NULL
        AND e.status='approved' AND e.sha256=NEW.evidence_sha256 AND e.uploaded_by_user_id<>a.user_id
        AND w.prepared_by_user_id<>a.user_id AND w.status='reviewed'
    ) THEN
      RAISE EXCEPTION 'Exact active appointed reviewer and current evidence required' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
