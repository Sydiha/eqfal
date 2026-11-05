-- Migration 097 (C4-P2b-1): auditable acceptance of incomplete evidence on an opening balance review.
-- Additive only: one new table, three trigger functions, one capability. No existing table, column, constraint or row is changed,
-- no backfill, no automatic acceptance. Approved reviews and their journals are never touched.
--
-- An exception records that a named user, with a written reason, accepted ONE reconciliation issue of class incomplete_evidence
-- (the nine codes in the CHECK below) while the review was in_review. It never changes the reconciliation classification, an item,
-- a journal or any amount; blocked and mismatch issues cannot be recorded (the CHECK rejects their codes, also on a direct INSERT).
-- issue_key and evidence_fingerprint are computed by the server only (sha256 hex); the database stores and protects them.
--
-- Lifecycle: active -> superseded (item or evidence changed, or the review returned to draft) | revoked (explicit, with a reason).
-- Acceptance content is immutable: only status and the end columns may change, once, from active. Rows are never deleted
-- (except by the cascade of the owning review/company). Once the review is approved the table is frozen.
-- item_id has no foreign key on purpose: items are deleted in draft, and an accepted record must outlive them. The INSERT trigger
-- verifies that the item belongs to the same company and review.
--
-- Capability opening_balance.exception.accept is granted to existing default "Finance Manager" roles (those that already hold
-- opening_balance.approve); Full Access holds it through the wildcard (075). Accountant and Viewer receive nothing.
-- PREREQUISITES: 001-096 applied. Applying it is automatic at server start-up: needs Owner approval before any shared environment runs it.
-- Rollback (only while the table is empty): DROP TRIGGER opening_balance_items_exception_supersede ON opening_balance_items;
--   DROP TABLE opening_balance_evidence_exceptions; DROP FUNCTION opening_balance_exception_guard(), opening_balance_exception_item_supersede();
--   DELETE FROM capabilities WHERE id = 'opening_balance.exception.accept';

INSERT INTO capabilities (id) VALUES ('opening_balance.exception.accept') ON CONFLICT (id) DO NOTHING;

CREATE TABLE opening_balance_evidence_exceptions (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id            UUID        NOT NULL,
  item_id              UUID,
  section              TEXT        NOT NULL CHECK (section IN ('bank', 'receivable', 'payable')),
  issue_code           TEXT        NOT NULL CHECK (issue_code IN (
                         'OB_BANK_AGGREGATE_ONLY', 'OB_REFERENCE_MISSING', 'OB_BANK_EVIDENCE_MISSING', 'OB_BANK_CURRENCY_NOT_COMPARABLE',
                         'OB_FUNCTIONAL_CURRENCY_UNKNOWN', 'OB_CONTROL_ACCOUNT_UNMAPPED', 'OB_SUBLEDGER_AGGREGATE_ONLY',
                         'OB_SUBLEDGER_UNLINKED_OBLIGATION', 'OB_SUBLEDGER_TOTAL_DIFFERENCE')),
  issue_key            TEXT        NOT NULL CHECK (issue_key ~ '^[0-9a-f]{64}$'),
  issue_snapshot       JSONB       NOT NULL CHECK (jsonb_typeof(issue_snapshot) = 'object'),
  evidence_fingerprint TEXT        NOT NULL CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  item_version         INTEGER     CHECK (item_version IS NULL OR item_version > 0),
  acknowledged_difference TEXT     CHECK (acknowledged_difference IS NULL OR acknowledged_difference ~ '^-?[0-9]+\.[0-9]{2}$'),
  reason               TEXT        NOT NULL CHECK (char_length(reason) <= 1000 AND char_length(regexp_replace(reason, '\s', '', 'g')) >= 10),
  accepted_by          UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status               TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'revoked')),
  ended_by             UUID        REFERENCES users(id) ON DELETE RESTRICT,
  ended_at             TIMESTAMPTZ,
  end_reason           TEXT        CHECK (end_reason IS NULL OR char_length(end_reason) <= 1000),
  UNIQUE (id, company_id),
  FOREIGN KEY (review_id, company_id) REFERENCES opening_balance_reviews(id, company_id) ON DELETE CASCADE,
  -- Aggregate issues (no single item) carry no item_id; every other code names its item.
  CONSTRAINT ob_exception_item_scope CHECK ((issue_code IN ('OB_SUBLEDGER_UNLINKED_OBLIGATION', 'OB_SUBLEDGER_TOTAL_DIFFERENCE')) = (item_id IS NULL)),
  -- An aggregate total difference is accepted only together with the exact difference the reviewer saw.
  CONSTRAINT ob_exception_difference_ack CHECK ((issue_code = 'OB_SUBLEDGER_TOTAL_DIFFERENCE') = (acknowledged_difference IS NOT NULL)),
  CONSTRAINT ob_exception_end_state CHECK (
    (status = 'active' AND ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL)
    OR (status = 'superseded' AND ended_at IS NOT NULL AND end_reason IS NOT NULL)
    OR (status = 'revoked' AND ended_at IS NOT NULL AND ended_by IS NOT NULL
        AND end_reason IS NOT NULL AND char_length(regexp_replace(end_reason, '\s', '', 'g')) >= 10)
  )
);
-- One live acceptance per issue: a concurrent double accept loses on this index.
CREATE UNIQUE INDEX opening_balance_exceptions_active_uidx ON opening_balance_evidence_exceptions (company_id, review_id, issue_key) WHERE status = 'active';
CREATE INDEX opening_balance_exceptions_review_idx ON opening_balance_evidence_exceptions (company_id, review_id, accepted_at, id);

CREATE FUNCTION opening_balance_exception_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only the cascade of a deleted review/company may remove rows: the parent is already gone then.
    IF EXISTS (SELECT 1 FROM opening_balance_reviews WHERE id = OLD.review_id AND company_id = OLD.company_id) THEN
      RAISE EXCEPTION 'opening balance evidence exceptions cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO review_status FROM opening_balance_reviews WHERE id = NEW.review_id AND company_id = NEW.company_id;
  IF TG_OP = 'INSERT' THEN
    IF review_status IS DISTINCT FROM 'in_review' THEN
      RAISE EXCEPTION 'evidence exceptions can be accepted only while the review is in review' USING ERRCODE = '55000';
    END IF;
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'a new evidence exception must be active' USING ERRCODE = '55000';
    END IF;
    IF NEW.item_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM opening_balance_items WHERE id = NEW.item_id AND company_id = NEW.company_id AND review_id = NEW.review_id) THEN
      RAISE EXCEPTION 'evidence exception item does not belong to the review' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: acceptance content is frozen; only the one-way end of an active exception is possible.
  IF review_status = 'approved' THEN
    RAISE EXCEPTION 'evidence exceptions of an approved opening balance are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'active' OR NEW.status = 'active' THEN
    RAISE EXCEPTION 'an ended evidence exception is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'revoked' AND review_status <> 'in_review' THEN
    RAISE EXCEPTION 'evidence exceptions can be revoked only while the review is in review' USING ERRCODE = '55000';
  END IF;
  IF (NEW.id, NEW.company_id, NEW.review_id, NEW.item_id, NEW.section, NEW.issue_code, NEW.issue_key, NEW.issue_snapshot,
      NEW.evidence_fingerprint, NEW.item_version, NEW.acknowledged_difference, NEW.reason, NEW.accepted_by, NEW.accepted_at)
     IS DISTINCT FROM
     (OLD.id, OLD.company_id, OLD.review_id, OLD.item_id, OLD.section, OLD.issue_code, OLD.issue_key, OLD.issue_snapshot,
      OLD.evidence_fingerprint, OLD.item_version, OLD.acknowledged_difference, OLD.reason, OLD.accepted_by, OLD.accepted_at) THEN
    RAISE EXCEPTION 'evidence exception content is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opening_balance_exceptions_guard BEFORE INSERT OR UPDATE OR DELETE ON opening_balance_evidence_exceptions
  FOR EACH ROW EXECUTE FUNCTION opening_balance_exception_guard();

-- Defence in depth over the service: any change to an item (or a new item) ends the live acceptances it can affect.
-- Items are editable only in draft, where the service has already superseded everything; this guards direct writes.
CREATE FUNCTION opening_balance_exception_item_supersede() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid UUID := COALESCE(NEW.review_id, OLD.review_id); cid UUID := COALESCE(NEW.company_id, OLD.company_id);
BEGIN
  IF EXISTS (SELECT 1 FROM opening_balance_reviews WHERE id = rid AND company_id = cid AND status <> 'approved') THEN
    UPDATE opening_balance_evidence_exceptions
       SET status = 'superseded', ended_at = NOW(), end_reason = 'item_changed'
     WHERE company_id = cid AND review_id = rid AND status = 'active'
       AND (item_id IS NULL OR item_id = COALESCE(OLD.id, NEW.id));
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER opening_balance_items_exception_supersede AFTER INSERT OR UPDATE OR DELETE ON opening_balance_items
  FOR EACH ROW EXECUTE FUNCTION opening_balance_exception_item_supersede();

-- Existing default Finance Manager roles (those that can already approve an opening balance). Idempotent.
INSERT INTO role_capabilities (role_id, capability_id)
SELECT r.id, 'opening_balance.exception.accept'
FROM roles r
WHERE r.name IN ('Finance Manager', 'finance_manager') AND r.is_full_access = FALSE
  AND EXISTS (SELECT 1 FROM role_capabilities rc WHERE rc.role_id = r.id AND rc.capability_id = 'opening_balance.approve')
ON CONFLICT (role_id, capability_id) DO NOTHING;
