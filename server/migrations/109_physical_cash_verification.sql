-- Forward-only evidence decisions. Existing reviews and journals are untouched.
INSERT INTO capabilities(id) VALUES ('opening_balance.evidence.verify') ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_id,capability_id)
SELECT rc.role_id,'opening_balance.evidence.verify' FROM role_capabilities rc
JOIN roles r ON r.id=rc.role_id WHERE rc.capability_id='opening_balance.approve'
  AND r.name IN ('Finance Manager','finance_manager') AND r.is_full_access=FALSE
ON CONFLICT DO NOTHING;

CREATE TABLE opening_balance_cash_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id uuid NOT NULL,
  item_id uuid NOT NULL,
  issue_key text NOT NULL CHECK (issue_key ~ '^[0-9a-f]{64}$'),
  evidence_fingerprint text NOT NULL CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  item_version integer NOT NULL CHECK (item_version > 0),
  evidence_reference text NOT NULL CHECK (length(trim(evidence_reference)) BETWEEN 1 AND 500),
  decision text NOT NULL CHECK (decision IN ('verified','rejected','conflicting')),
  rationale text NOT NULL CHECK (length(regexp_replace(rationale,'\s','','g')) >= 10 AND length(rationale) <= 1000),
  reviewed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (review_id,company_id) REFERENCES opening_balance_reviews(id,company_id) ON DELETE CASCADE
);
CREATE INDEX opening_balance_cash_verifications_latest_idx
  ON opening_balance_cash_verifications(company_id,review_id,item_id,reviewed_at DESC,id DESC);

CREATE FUNCTION opening_balance_cash_verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preparer uuid; review_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM opening_balance_reviews WHERE id=OLD.review_id AND company_id=OLD.company_id) THEN
      RAISE EXCEPTION 'cash verification decisions cannot be deleted' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'cash verification decisions are immutable' USING ERRCODE='55000';
  END IF;
  SELECT prepared_by,status INTO preparer,review_status FROM opening_balance_reviews
    WHERE id=NEW.review_id AND company_id=NEW.company_id;
  IF review_status IS DISTINCT FROM 'in_review' OR preparer=NEW.reviewed_by THEN
    RAISE EXCEPTION 'invalid cash evidence reviewer or review state' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM opening_balance_items WHERE id=NEW.item_id AND review_id=NEW.review_id
    AND company_id=NEW.company_id AND category='cash_on_hand' AND version=NEW.item_version) THEN
    RAISE EXCEPTION 'cash verification item does not match review' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opening_balance_cash_verification_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON opening_balance_cash_verifications
  FOR EACH ROW EXECUTE FUNCTION opening_balance_cash_verification_guard();
