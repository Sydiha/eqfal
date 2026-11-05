-- Owner-approved, narrowly scoped System Admin self-review of physical cash evidence.
-- Historical decisions remain untouched; new rows disclose their review type.
ALTER TABLE opening_balance_cash_verifications
  ADD COLUMN verification_type text NOT NULL DEFAULT 'independent_human'
    CHECK (verification_type IN ('independent_human','administrative_self_review')),
  ADD COLUMN override_actor uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN override_preparer uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN override_reason text,
  ADD CONSTRAINT opening_balance_cash_override_shape CHECK (
    (verification_type = 'independent_human' AND override_actor IS NULL AND override_preparer IS NULL AND override_reason IS NULL)
    OR
    (verification_type = 'administrative_self_review' AND override_actor IS NOT NULL
      AND override_preparer IS NOT NULL AND override_actor = reviewed_by AND override_actor = override_preparer
      AND length(regexp_replace(COALESCE(override_reason,''),'\s','','g')) >= 10
      AND length(override_reason) <= 1000)
  );

CREATE OR REPLACE FUNCTION opening_balance_cash_verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF review_status IS DISTINCT FROM 'in_review' THEN
    RAISE EXCEPTION 'invalid cash evidence review state' USING ERRCODE='55000';
  END IF;
  IF preparer=NEW.reviewed_by THEN
    IF NEW.verification_type IS DISTINCT FROM 'administrative_self_review'
      OR NEW.override_actor IS DISTINCT FROM NEW.reviewed_by
      OR NEW.override_preparer IS DISTINCT FROM preparer
      OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.reviewed_by AND is_active AND is_system_admin)
      OR length(regexp_replace(COALESCE(NEW.override_reason,''),'\s','','g')) < 10 THEN
      RAISE EXCEPTION 'invalid cash evidence reviewer or override' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.verification_type IS DISTINCT FROM 'independent_human'
    OR NEW.override_actor IS NOT NULL OR NEW.override_preparer IS NOT NULL OR NEW.override_reason IS NOT NULL THEN
    RAISE EXCEPTION 'override is only valid for preparer self-review' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM opening_balance_items WHERE id=NEW.item_id AND review_id=NEW.review_id
    AND company_id=NEW.company_id AND category='cash_on_hand' AND version=NEW.item_version) THEN
    RAISE EXCEPTION 'cash verification item does not match review' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
