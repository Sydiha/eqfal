-- Preserve every historical decision. Existing B9 approvals have no verifiable
-- calculation/suite binding, so they must be explicitly reviewed anew.
ALTER TABLE zakat_regulatory_decisions
  ADD COLUMN engine_version text,
  ADD COLUMN reference_suite_digest text,
  ADD COLUMN stale_at timestamptz,
  ADD COLUMN stale_reason text,
  ADD CONSTRAINT zakat_decision_stale_pair CHECK ((stale_at IS NULL) = (stale_reason IS NULL)),
  ADD CONSTRAINT zakat_decision_binding_pair CHECK ((engine_version IS NULL) = (reference_suite_digest IS NULL)),
  ADD CONSTRAINT zakat_decision_binding_format CHECK (engine_version IS NULL OR
    (engine_version ~ '^sha256:[0-9a-f]{64}$' AND reference_suite_digest ~ '^sha256:[0-9a-f]{64}$'));

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
    IF NEW.reviewed_by IS NOT NULL OR NEW.ended_by IS NOT NULL OR NEW.stale_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM zakat_worksheets w WHERE w.id=NEW.worksheet_id AND w.company_id=NEW.company_id
        AND w.fiscal_year_id=NEW.fiscal_year_id
    ) THEN
      RAISE EXCEPTION 'Zakat decisions must start pending and match the worksheet period' USING ERRCODE = '23514';
    END IF;
    IF NEW.gate='B9' AND (NEW.engine_version IS NULL OR NEW.reference_suite_digest IS NULL
      OR NEW.facts->>'engineVersion' IS DISTINCT FROM NEW.engine_version
      OR NEW.facts->>'referenceSuiteDigest' IS DISTINCT FROM NEW.reference_suite_digest) THEN
      RAISE EXCEPTION 'B9 calculation and reference suite binding required' USING ERRCODE = '23514';
    END IF;
    IF NEW.gate<>'B9' AND NEW.engine_version IS NOT NULL THEN
      RAISE EXCEPTION 'B9 binding on non-B9 decision' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.ended_at IS NOT NULL OR
    (to_jsonb(OLD) - ARRAY['reviewed_by','reviewer_appointment','approved_at','ended_by','ended_at','end_reason','stale_at','stale_reason'])
      IS DISTINCT FROM
    (to_jsonb(NEW) - ARRAY['reviewed_by','reviewer_appointment','approved_at','ended_by','ended_at','end_reason','stale_at','stale_reason']) THEN
    RAISE EXCEPTION 'Zakat regulatory decision history is immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.stale_at, OLD.stale_reason) IS DISTINCT FROM (NEW.stale_at, NEW.stale_reason) THEN
    IF OLD.stale_at IS NOT NULL OR OLD.approved_at IS NULL OR NEW.stale_at IS NULL
      OR btrim(COALESCE(NEW.stale_reason,''))='' THEN
      RAISE EXCEPTION 'Stale Zakat approval cannot be restored or changed' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (OLD.reviewed_by, OLD.reviewer_appointment, OLD.approved_at)
     IS DISTINCT FROM (NEW.reviewed_by, NEW.reviewer_appointment, NEW.approved_at) THEN
    IF OLD.reviewed_by IS NOT NULL OR NEW.ended_at IS NOT NULL OR NEW.stale_at IS NOT NULL
      OR (NEW.gate='B9' AND (NEW.engine_version IS NULL OR NEW.reference_suite_digest IS NULL
        OR NEW.facts->>'engineVersion' IS DISTINCT FROM NEW.engine_version
        OR NEW.facts->>'referenceSuiteDigest' IS DISTINCT FROM NEW.reference_suite_digest))
      OR NOT EXISTS (
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

UPDATE zakat_regulatory_decisions SET stale_at=now(), stale_reason='legacy_b9_binding_missing'
  WHERE gate='B9' AND approved_at IS NOT NULL AND stale_at IS NULL;

-- Evidence changes are recorded at the moment they happen, including a change
-- followed immediately by restoration of the prior status or SHA.
CREATE FUNCTION stale_zakat_decisions_on_document_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status OR OLD.sha256 IS DISTINCT FROM NEW.sha256
     OR OLD.uploaded_by_user_id IS DISTINCT FROM NEW.uploaded_by_user_id THEN
    UPDATE zakat_regulatory_decisions SET stale_at=now(),stale_reason='evidence_changed'
      WHERE evidence_document_id=OLD.id AND approved_at IS NOT NULL AND ended_at IS NULL AND stale_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zakat_decision_document_stale AFTER UPDATE OF status,sha256,uploaded_by_user_id ON documents
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_document_change();

CREATE FUNCTION stale_zakat_decisions_on_reviewer_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE zakat_regulatory_decisions SET stale_at=now(),stale_reason='reviewer_appointment_changed'
    WHERE company_id=OLD.company_id AND reviewed_by=OLD.user_id AND approved_at IS NOT NULL
      AND ended_at IS NULL AND stale_at IS NULL;
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER zakat_decision_reviewer_stale AFTER UPDATE OR DELETE ON zakat_regulatory_reviewers
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_reviewer_change();

CREATE FUNCTION stale_zakat_decisions_on_user_deactivation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    UPDATE zakat_regulatory_decisions SET stale_at=now(),stale_reason='reviewer_deactivated'
      WHERE reviewed_by=OLD.id AND approved_at IS NOT NULL AND ended_at IS NULL AND stale_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zakat_decision_reviewer_user_stale AFTER UPDATE OF is_active ON users
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_user_deactivation();

-- Persist source changes even if an edit and its reversal occur between reads.
-- Broad company scope is intentional: source period attribution may itself change.
CREATE FUNCTION stale_zakat_decisions_on_source_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_company uuid;
BEGIN
  affected_company := COALESCE(NEW.company_id,OLD.company_id);
  UPDATE zakat_regulatory_decisions SET stale_at=now(),stale_reason='company_source_changed'
    WHERE company_id=affected_company AND approved_at IS NOT NULL AND ended_at IS NULL AND stale_at IS NULL;
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER zakat_decision_fiscal_year_source_stale AFTER UPDATE ON fiscal_years
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_source_change();
CREATE TRIGGER zakat_decision_profile_source_stale AFTER INSERT OR UPDATE OR DELETE ON company_accounting_profiles
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_source_change();
CREATE TRIGGER zakat_decision_partner_source_stale AFTER INSERT OR UPDATE OR DELETE ON partners
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_source_change();
CREATE TRIGGER zakat_decision_ownership_source_stale AFTER INSERT OR UPDATE OR DELETE ON partner_ownership_periods
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_source_change();
CREATE TRIGGER zakat_decision_eligibility_source_stale AFTER INSERT OR UPDATE OR DELETE ON zakat_ownership_eligibility
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_source_change();
CREATE TRIGGER zakat_decision_account_source_stale AFTER INSERT OR UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_source_change();
CREATE TRIGGER zakat_decision_classification_source_stale AFTER INSERT OR UPDATE OR DELETE ON zakat_account_classifications
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_source_change();
CREATE TRIGGER zakat_decision_adjustment_source_stale AFTER INSERT OR UPDATE OR DELETE ON zakat_worksheet_adjustments
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_source_change();
CREATE TRIGGER zakat_decision_posted_entry_source_stale AFTER INSERT OR UPDATE ON journal_entries
  FOR EACH ROW WHEN (NEW.status='posted') EXECUTE FUNCTION stale_zakat_decisions_on_source_change();

CREATE FUNCTION stale_zakat_decisions_on_worksheet_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.version IS DISTINCT FROM OLD.version AND NOT (OLD.status='reviewed' AND NEW.status='approved'))
     OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status='reviewed' AND NEW.status='approved')) THEN
    UPDATE zakat_regulatory_decisions SET stale_at=now(),stale_reason='worksheet_source_changed'
      WHERE worksheet_id=OLD.id AND approved_at IS NOT NULL AND ended_at IS NULL AND stale_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zakat_decision_worksheet_source_stale AFTER UPDATE ON zakat_worksheets
  FOR EACH ROW EXECUTE FUNCTION stale_zakat_decisions_on_worksheet_change();
