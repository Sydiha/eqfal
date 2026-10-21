-- Migration 091 (Cutover S2): pre-cut-over historical supplements (cash flows and equity movements, 1 Jan -> D).
--
-- A company that adopts EQFAL mid-year holds only ONE cut-over journal for the dates up to D (086). The cash flows and equity movements behind
-- that journal are recorded here as REPORT DATA with external evidence: they are never posted, never written to journal_lines and never
-- derived from balances. Each supplement is a version of one kind ('cash_flow' or 'equity') for one ACTIVE authority range:
--   draft -> approved -> superseded, or draft -> voided. Lines change only while the version is a draft; approval freezes the version.
--   At most one approved and one draft version per (authority, kind). Nothing is ever deleted (lines of a draft may be replaced).
-- The invariants (C1-C5, E1-E4) are checked by the application at approval and again on every report; the database guards shape and lifecycle.
--
-- What this migration does NOT do: change ledger_source_authority (086 forbids updating a non-draft range; supplements only reference it by
-- FK, and an FK insert never updates the parent), change any existing table, row, journal, audit event or approved balance, or grant
-- any role a capability. Capabilities are registered only; Full Access holds them through the 075 wildcard.
-- PREREQUISITES: 083, 086 applied; tables companies, users, accounts, journal_entries, ledger_source_authority, capabilities.
-- ROLLBACK (only while no supplement row exists): DROP TABLE cutover_supplement_lines; DROP TABLE cutover_supplement_versions;
--   DROP FUNCTION cutover_supplement_versions_guard(), cutover_supplement_lines_guard(), cutover_supplement_no_delete();
--   DELETE FROM capabilities WHERE id IN ('source_authority.supplement_manage','source_authority.supplement_approve');
--   DELETE FROM _schema_migrations WHERE filename = '091_cutover_historical_supplements.sql'.

CREATE TABLE cutover_supplement_versions (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  authority_id           UUID        NOT NULL,
  kind                   TEXT        NOT NULL CHECK (kind IN ('cash_flow', 'equity')),
  version_no             INTEGER     NOT NULL CHECK (version_no >= 1),
  status                 TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded', 'voided')),
  supersedes_id          UUID,
  source_system          TEXT        NOT NULL CHECK (char_length(btrim(source_system)) BETWEEN 1 AND 200),
  evidence_reference     TEXT        NOT NULL CHECK (char_length(btrim(evidence_reference)) BETWEEN 1 AND 200),
  fx_translation_evidence TEXT       CHECK (fx_translation_evidence IS NULL OR char_length(btrim(fx_translation_evidence)) BETWEEN 1 AND 500),
  functional_currency    CHAR(3)     NOT NULL,
  prepared_by            UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  prepared_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_version            INTEGER     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  approved_by            UUID        REFERENCES users(id) ON DELETE RESTRICT,
  approved_at            TIMESTAMPTZ,
  cutover_journal_id     UUID,
  ledger_fingerprint     TEXT        CHECK (ledger_fingerprint IS NULL OR ledger_fingerprint ~ '^[0-9a-f]{64}$'),
  approval_snapshot      JSONB,
  superseded_by_id       UUID,
  superseded_at          TIMESTAMPTZ,
  voided_by              UUID        REFERENCES users(id) ON DELETE RESTRICT,
  voided_at              TIMESTAMPTZ,
  void_reason            TEXT        CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 1 AND 500),
  UNIQUE (id, company_id),
  UNIQUE (authority_id, kind, version_no),
  FOREIGN KEY (authority_id, company_id) REFERENCES ledger_source_authority(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_id, company_id) REFERENCES cutover_supplement_versions(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (superseded_by_id, company_id) REFERENCES cutover_supplement_versions(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (cutover_journal_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  CHECK ((status IN ('approved', 'superseded')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL AND cutover_journal_id IS NOT NULL AND ledger_fingerprint IS NOT NULL AND approval_snapshot IS NOT NULL)),
  CHECK ((status = 'superseded') = (superseded_by_id IS NOT NULL AND superseded_at IS NOT NULL)),
  CHECK ((status = 'voided') = (voided_by IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE UNIQUE INDEX cutover_supplement_one_approved_uidx ON cutover_supplement_versions (authority_id, kind) WHERE status = 'approved';
CREATE UNIQUE INDEX cutover_supplement_one_draft_uidx ON cutover_supplement_versions (authority_id, kind) WHERE status = 'draft';
CREATE INDEX cutover_supplement_versions_company_idx ON cutover_supplement_versions (company_id, authority_id, kind, version_no);

-- Line shapes (amounts in the functional currency, signed, two decimals):
--   cash_balance    : one per cash / cash-equivalent account of the cut-over journal: opening_amount (1 Jan) and closing_amount (D, debit - credit).
--   cash_flow       : section + label + amount (cash inflow positive); optional non-cash counterpart account; a section different from the
--                     account's cash_flow_category needs a written classification_override_reason (the account itself is never changed).
--   equity_opening  : one per equity account: opening_amount (1 Jan, credit - debit).
--   equity_movement : equity account + movement_type + label + amount (increase in equity positive).
CREATE TABLE cutover_supplement_lines (
  id                             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                     UUID          NOT NULL,
  version_id                     UUID          NOT NULL,
  line_no                        INTEGER       NOT NULL CHECK (line_no >= 1),
  line_type                      TEXT          NOT NULL CHECK (line_type IN ('cash_balance', 'cash_flow', 'equity_opening', 'equity_movement')),
  account_id                     UUID,
  section                        TEXT          CHECK (section IS NULL OR section IN ('operating', 'investing', 'financing', 'fx_effect')),
  movement_type                  TEXT          CHECK (movement_type IS NULL OR movement_type IN ('contribution', 'distribution', 'transfer', 'other')),
  label                          TEXT          CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 200),
  amount                         NUMERIC(18,2),
  opening_amount                 NUMERIC(18,2),
  closing_amount                 NUMERIC(18,2),
  classification_override_reason TEXT          CHECK (classification_override_reason IS NULL OR char_length(btrim(classification_override_reason)) BETWEEN 10 AND 500),
  UNIQUE (version_id, line_no),
  FOREIGN KEY (version_id, company_id) REFERENCES cutover_supplement_versions(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  CHECK (CASE line_type
    WHEN 'cash_balance' THEN account_id IS NOT NULL AND opening_amount IS NOT NULL AND closing_amount IS NOT NULL
      AND section IS NULL AND movement_type IS NULL AND amount IS NULL AND label IS NULL AND classification_override_reason IS NULL
    WHEN 'cash_flow' THEN section IS NOT NULL AND label IS NOT NULL AND amount IS NOT NULL AND amount <> 0
      AND movement_type IS NULL AND opening_amount IS NULL AND closing_amount IS NULL
      AND (classification_override_reason IS NULL OR account_id IS NOT NULL)
    WHEN 'equity_opening' THEN account_id IS NOT NULL AND opening_amount IS NOT NULL
      AND section IS NULL AND movement_type IS NULL AND amount IS NULL AND closing_amount IS NULL AND label IS NULL AND classification_override_reason IS NULL
    ELSE account_id IS NOT NULL AND movement_type IS NOT NULL AND label IS NOT NULL AND amount IS NOT NULL AND amount <> 0
      AND section IS NULL AND opening_amount IS NULL AND closing_amount IS NULL AND classification_override_reason IS NULL
  END)
);
CREATE INDEX cutover_supplement_lines_version_idx ON cutover_supplement_lines (company_id, version_id, line_no);

-- Lifecycle guard. INSERT: a new version is a draft of an ACTIVE range of the same company. UPDATE: identity never changes;
-- draft -> draft (evidence edit, row_version + 1), draft -> approved, draft -> voided, approved -> superseded (by an approved successor). Nothing else.
CREATE FUNCTION cutover_supplement_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.row_version <> 1 THEN
      RAISE EXCEPTION 'SUPPLEMENT_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'A supplement version is created as a draft';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ledger_source_authority a WHERE a.id = NEW.authority_id AND a.company_id = NEW.company_id AND a.status = 'active') THEN
      RAISE EXCEPTION 'SUPPLEMENT_AUTHORITY_NOT_ACTIVE' USING ERRCODE = '23514', DETAIL = 'Supplements belong to an activated cut-over range';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.company_id, NEW.authority_id, NEW.kind, NEW.version_no, NEW.supersedes_id, NEW.prepared_by, NEW.prepared_at, NEW.functional_currency)
     IS DISTINCT FROM (OLD.id, OLD.company_id, OLD.authority_id, OLD.kind, OLD.version_no, OLD.supersedes_id, OLD.prepared_by, OLD.prepared_at, OLD.functional_currency) THEN
    RAISE EXCEPTION 'SUPPLEMENT_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Supplement identity cannot change';
  END IF;
  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'approved', 'voided') THEN
    IF NEW.row_version <> OLD.row_version + 1 THEN
      RAISE EXCEPTION 'SUPPLEMENT_STALE_WRITE' USING ERRCODE = '40001', DETAIL = 'Every change of a draft increments row_version once';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'superseded'
     AND (NEW.source_system, NEW.evidence_reference, NEW.fx_translation_evidence, NEW.row_version, NEW.approved_by, NEW.approved_at, NEW.cutover_journal_id, NEW.ledger_fingerprint, NEW.approval_snapshot)
         IS NOT DISTINCT FROM (OLD.source_system, OLD.evidence_reference, OLD.fx_translation_evidence, OLD.row_version, OLD.approved_by, OLD.approved_at, OLD.cutover_journal_id, OLD.ledger_fingerprint, OLD.approval_snapshot)
     AND EXISTS (SELECT 1 FROM cutover_supplement_versions s WHERE s.id = NEW.superseded_by_id AND s.company_id = NEW.company_id
                   AND s.authority_id = NEW.authority_id AND s.kind = NEW.kind AND s.supersedes_id = NEW.id AND s.status = 'draft') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SUPPLEMENT_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'An approved, superseded or voided supplement cannot change';
END $$;
CREATE TRIGGER cutover_supplement_versions_guard BEFORE INSERT OR UPDATE ON cutover_supplement_versions
  FOR EACH ROW EXECUTE FUNCTION cutover_supplement_versions_guard();

CREATE FUNCTION cutover_supplement_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SUPPLEMENT_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Supplement versions are never deleted';
END $$;
CREATE TRIGGER cutover_supplement_versions_no_delete BEFORE DELETE ON cutover_supplement_versions
  FOR EACH ROW EXECUTE FUNCTION cutover_supplement_no_delete();

-- Lines change only while their version is a draft (approval freezes them).
CREATE FUNCTION cutover_supplement_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
        c_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.version_id, NEW.company_id) IS DISTINCT FROM (OLD.version_id, OLD.company_id) THEN
    RAISE EXCEPTION 'SUPPLEMENT_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'A line cannot move to another version';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cutover_supplement_versions v WHERE v.id = v_id AND v.company_id = c_id AND v.status = 'draft') THEN
    RAISE EXCEPTION 'SUPPLEMENT_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Lines of an approved, superseded or voided supplement cannot change';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER cutover_supplement_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON cutover_supplement_lines
  FOR EACH ROW EXECUTE FUNCTION cutover_supplement_lines_guard();

-- Capabilities (registration only, like 086: no role_capabilities row; Full Access holds them through the 075 wildcard).
INSERT INTO capabilities (id) VALUES ('source_authority.supplement_manage'), ('source_authority.supplement_approve') ON CONFLICT (id) DO NOTHING;
