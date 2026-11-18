-- Reviewer appointments are provisioned by the trusted operator after verifying credentials.
-- Company roles and application requests cannot create appointments.
CREATE TABLE zakat_regulatory_reviewers (
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  appointment_reference text NOT NULL CHECK (btrim(appointment_reference) <> ''),
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE zakat_regulatory_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  worksheet_id uuid NOT NULL,
  gate text NOT NULL CHECK (gate IN ('B0', 'B3', 'B4', 'B7', 'B9')),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  evidence_document_id uuid NOT NULL,
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  authority_reference text NOT NULL CHECK (btrim(authority_reference) <> ''),
  facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
  submitted_by uuid NOT NULL REFERENCES users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id),
  reviewer_appointment text,
  approved_at timestamptz,
  ended_by uuid REFERENCES users(id),
  ended_at timestamptz,
  end_reason text,
  FOREIGN KEY (fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id),
  FOREIGN KEY (worksheet_id, company_id) REFERENCES zakat_worksheets(id, company_id),
  FOREIGN KEY (evidence_document_id, company_id) REFERENCES documents(id, company_id),
  CHECK ((reviewed_by IS NULL AND approved_at IS NULL AND reviewer_appointment IS NULL)
      OR (reviewed_by IS NOT NULL AND reviewed_by <> submitted_by AND approved_at IS NOT NULL AND reviewer_appointment IS NOT NULL)),
  CHECK ((ended_by IS NULL AND ended_at IS NULL AND end_reason IS NULL)
      OR (ended_by IS NOT NULL AND ended_at IS NOT NULL AND btrim(end_reason) <> '' AND end_reason IS NOT NULL))
);

CREATE UNIQUE INDEX zakat_regulatory_decisions_active_idx
  ON zakat_regulatory_decisions (company_id, fiscal_year_id, worksheet_id, gate)
  WHERE ended_at IS NULL;

CREATE FUNCTION guard_zakat_regulatory_decision() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NEW.reviewed_by IS NOT NULL OR NEW.ended_by IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM zakat_worksheets w WHERE w.id=NEW.worksheet_id AND w.company_id=NEW.company_id
        AND w.fiscal_year_id=NEW.fiscal_year_id
    ) THEN
      RAISE EXCEPTION 'Zakat decisions must start pending and match the worksheet period' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.ended_at IS NOT NULL OR
    (to_jsonb(OLD) - ARRAY['reviewed_by','reviewer_appointment','approved_at','ended_by','ended_at','end_reason'])
      IS DISTINCT FROM
    (to_jsonb(NEW) - ARRAY['reviewed_by','reviewer_appointment','approved_at','ended_by','ended_at','end_reason']) THEN
    RAISE EXCEPTION 'Zakat regulatory decision history is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.reviewed_by, OLD.reviewer_appointment, OLD.approved_at)
     IS DISTINCT FROM (NEW.reviewed_by, NEW.reviewer_appointment, NEW.approved_at) THEN
    IF OLD.reviewed_by IS NOT NULL OR NEW.ended_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM zakat_regulatory_reviewers a JOIN users u ON u.id=a.user_id AND u.is_active
      JOIN documents e ON e.id=NEW.evidence_document_id AND e.company_id=a.company_id
      JOIN zakat_worksheets w ON w.id=NEW.worksheet_id AND w.company_id=a.company_id
      WHERE a.company_id=NEW.company_id AND a.user_id=NEW.reviewed_by AND a.appointment_reference=NEW.reviewer_appointment
        AND e.status='approved' AND e.sha256=NEW.evidence_sha256 AND e.uploaded_by_user_id<>a.user_id
        AND w.prepared_by_user_id<>a.user_id AND w.status='reviewed'
    ) THEN
      RAISE EXCEPTION 'Independent appointed Zakat reviewer and current evidence required' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER zakat_regulatory_decision_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zakat_regulatory_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_zakat_regulatory_decision();
CREATE TRIGGER zakat_regulatory_decision_truncate_guard
  BEFORE TRUNCATE ON zakat_regulatory_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_zakat_regulatory_decision();
