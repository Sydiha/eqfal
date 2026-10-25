-- Migration 096 (C5-P2): historical financial records, schema and database guards only (no router, service or UI).
--
-- Historical periods hold what a company submitted officially for years before EQFAL (or outside it) and any internal reconstruction or
-- correction of those figures. They are records, never accounting: no table here references journal_entries, journal_lines, accounts,
-- fiscal_years or opening balances, and nothing here creates, changes or posts a journal. A historical period MAY overlap an operational
-- fiscal year; any reporting that relates the two must disclose the overlap (future work).
--
-- Owner decisions (C5-P1, 2026-10-25):
--   * Official submission data may be entered without proof; it is then marked proof_level = 'declared_unverified'.
--   * A sealed version is permanent. Errors are corrected by a NEW internal version (internal_purpose = 'correction') whose basis is the
--     erroneous version; an internal correction is never an official filing. A later official filing is a new official version.
--   * A completed reconstruction may be reopened (completed -> in_progress) with an explicit reason; authorization (historical.approve) is
--     enforced by the future application layer. Sealed versions stay immutable.
--   * Internal review / approval (review_status) records EQFAL's own review only; it is not government acceptance or accounting correctness.
--
-- Guards: a sealed version and its lines cannot change (only the forward review columns); versions and periods are never deleted (drafts
-- are voided); sealing computes a sha256 fingerprint in the database over the version, its lines and the sha256 of every referenced
-- document; documents referenced by historical rows cannot be deleted (FK RESTRICT) and, once referenced by a sealed version, their stored
-- file identity (storage_key, sha256, size, type, name, company) cannot change.
--
-- PREREQUISITES: 001-095 applied (companies, users, documents, capabilities).
-- PERFORMANCE: new tables only, plus one trigger on documents that fires only when a file-identity column is updated (no existing code path
-- updates those columns).
-- ROLLBACK (only while the three tables are empty):
--   DROP TRIGGER documents_historical_protection ON documents; DROP FUNCTION documents_historical_protection();
--   DROP TABLE historical_statement_lines, historical_statement_versions, historical_periods;  -- drops their triggers
--   DROP FUNCTION historical_periods_guard(), historical_statement_versions_guard(), historical_statement_lines_guard(),
--     historical_version_fingerprint(uuid);
--   DELETE FROM capabilities WHERE id IN ('historical.view','historical.manage','historical.approve');
--   DELETE FROM _schema_migrations WHERE filename = '096_historical_records.sql';

CREATE TABLE historical_periods (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  label                 TEXT        NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 200),
  period_start          DATE        NOT NULL,
  period_end            DATE        NOT NULL,
  completeness          TEXT        NOT NULL CHECK (completeness IN ('complete', 'incomplete')),
  reconstruction_status TEXT        NOT NULL DEFAULT 'not_started' CHECK (reconstruction_status IN ('not_started', 'in_progress', 'completed')),
  status_reason         TEXT        NOT NULL CHECK (char_length(btrim(status_reason)) BETWEEN 1 AND 500),
  status_changed_by     UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status_changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by            UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, period_start, period_end),
  CHECK (period_start < period_end)
);

CREATE TABLE historical_statement_versions (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID        NOT NULL,
  period_id              UUID        NOT NULL,
  kind                   TEXT        NOT NULL CHECK (kind IN ('official', 'internal')),
  statement_type         TEXT        NOT NULL CHECK (statement_type IN
                           ('financial_position', 'profit_or_loss', 'cash_flow', 'changes_in_equity', 'zakat_return', 'vat_return')),
  version_no             INTEGER     NOT NULL CHECK (version_no >= 1),
  state                  TEXT        NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'sealed', 'voided')),
  functional_currency    TEXT        NOT NULL CHECK (functional_currency ~ '^[A-Z]{3}$'),
  -- official submission (kind = 'official')
  submitted_to           TEXT        CHECK (submitted_to IS NULL OR char_length(btrim(submitted_to)) BETWEEN 1 AND 200),
  submission_date        DATE,
  submission_reference   TEXT        CHECK (submission_reference IS NULL OR char_length(btrim(submission_reference)) BETWEEN 1 AND 200),
  proof_level            TEXT        CHECK (proof_level IS NULL OR proof_level IN ('proof_attached', 'declared_unverified')),
  proof_document_id      UUID,
  -- internal reconstruction / correction (kind = 'internal')
  internal_purpose       TEXT        CHECK (internal_purpose IS NULL OR internal_purpose IN ('reconstruction', 'correction')),
  basis_version_id       UUID,
  source_type            TEXT        CHECK (source_type IS NULL OR source_type IN (
                           'bank_statement', 'customer_statement', 'supplier_statement', 'official_filing', 'prior_filing', 'original_document',
                           'internal_ledger', 'management_reconciliation', 'manual_unverified')),
  confidence             TEXT        CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  evidence_reference     TEXT        CHECK (evidence_reference IS NULL OR char_length(btrim(evidence_reference)) BETWEEN 1 AND 500),
  evidence_document_id   UUID,
  method_note            TEXT        CHECK (method_note IS NULL OR char_length(method_note) <= 2000),
  -- sealing
  fingerprint            TEXT        CHECK (fingerprint IS NULL OR fingerprint ~ '^[0-9a-f]{64}$'),
  sealed_by              UUID        REFERENCES users(id) ON DELETE RESTRICT,
  sealed_at              TIMESTAMPTZ,
  -- internal review only (never government acceptance)
  review_status          TEXT        NOT NULL DEFAULT 'none' CHECK (review_status IN ('none', 'reviewed', 'approved')),
  reviewed_by            UUID        REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at            TIMESTAMPTZ,
  approved_by            UUID        REFERENCES users(id) ON DELETE RESTRICT,
  approved_at            TIMESTAMPTZ,
  void_reason            TEXT        CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 1 AND 500),
  voided_by              UUID        REFERENCES users(id) ON DELETE RESTRICT,
  voided_at              TIMESTAMPTZ,
  created_by             UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (period_id, statement_type, version_no),
  FOREIGN KEY (period_id, company_id) REFERENCES historical_periods (id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (basis_version_id, company_id) REFERENCES historical_statement_versions (id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (proof_document_id, company_id) REFERENCES documents (id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_document_id, company_id) REFERENCES documents (id, company_id) ON DELETE RESTRICT,
  CHECK (basis_version_id IS NULL OR basis_version_id <> id),
  -- each kind carries only its own fields
  CHECK (kind <> 'official' OR (
    submitted_to IS NOT NULL AND submission_date IS NOT NULL AND proof_level IS NOT NULL
    AND internal_purpose IS NULL AND basis_version_id IS NULL AND source_type IS NULL AND confidence IS NULL
    AND evidence_reference IS NULL AND evidence_document_id IS NULL AND method_note IS NULL)),
  CHECK (kind <> 'internal' OR (
    internal_purpose IS NOT NULL AND source_type IS NOT NULL AND confidence IS NOT NULL
    AND submitted_to IS NULL AND submission_date IS NULL AND submission_reference IS NULL AND proof_level IS NULL AND proof_document_id IS NULL)),
  -- user-declared data carries no proof; attached proof needs a document
  CHECK ((proof_level = 'proof_attached') = (proof_document_id IS NOT NULL) OR kind = 'internal'),
  CHECK (internal_purpose IS DISTINCT FROM 'correction' OR basis_version_id IS NOT NULL),
  CHECK ((state = 'sealed') = (sealed_by IS NOT NULL AND sealed_at IS NOT NULL AND fingerprint IS NOT NULL)),
  CHECK ((state = 'voided') = (voided_by IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK (review_status = 'none' OR state = 'sealed'),
  CHECK ((review_status IN ('reviewed', 'approved')) = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK ((review_status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX historical_statement_versions_period_idx ON historical_statement_versions (company_id, period_id, statement_type, version_no);
CREATE INDEX historical_statement_versions_proof_doc_idx ON historical_statement_versions (proof_document_id) WHERE proof_document_id IS NOT NULL;
CREATE INDEX historical_statement_versions_evidence_doc_idx ON historical_statement_versions (evidence_document_id) WHERE evidence_document_id IS NOT NULL;
CREATE INDEX historical_statement_versions_basis_idx ON historical_statement_versions (basis_version_id) WHERE basis_version_id IS NOT NULL;

CREATE TABLE historical_statement_lines (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID          NOT NULL,
  version_id             UUID          NOT NULL,
  line_no                INTEGER       NOT NULL CHECK (line_no >= 1),
  line_kind              TEXT          NOT NULL DEFAULT 'statement_line' CHECK (line_kind = 'statement_line'),
  line_code              TEXT          NOT NULL CHECK (char_length(btrim(line_code)) BETWEEN 1 AND 100),
  label_ar               TEXT          CHECK (label_ar IS NULL OR char_length(btrim(label_ar)) BETWEEN 1 AND 300),
  label_en               TEXT          CHECK (label_en IS NULL OR char_length(btrim(label_en)) BETWEEN 1 AND 300),
  amount                 NUMERIC(18,2) NOT NULL,
  supporting_document_id UUID,
  note                   TEXT          CHECK (note IS NULL OR char_length(note) <= 1000),
  UNIQUE (version_id, line_code),
  UNIQUE (version_id, line_no),
  CHECK (label_ar IS NOT NULL OR label_en IS NOT NULL),
  FOREIGN KEY (version_id, company_id) REFERENCES historical_statement_versions (id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (supporting_document_id, company_id) REFERENCES documents (id, company_id) ON DELETE RESTRICT
);
CREATE INDEX historical_statement_lines_doc_idx ON historical_statement_lines (supporting_document_id) WHERE supporting_document_id IS NOT NULL;

-- Periods: identity is immutable; dates and label freeze once a version exists; every status change carries a new reason; no delete.
CREATE FUNCTION historical_periods_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HISTORICAL_RECORD_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Historical periods are never deleted';
  END IF;
  IF (NEW.id, NEW.company_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.company_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'HISTORICAL_RECORD_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Period identity cannot change';
  END IF;
  IF (NEW.period_start, NEW.period_end, NEW.label) IS DISTINCT FROM (OLD.period_start, OLD.period_end, OLD.label)
     AND EXISTS (SELECT 1 FROM historical_statement_versions v WHERE v.period_id = OLD.id) THEN
    RAISE EXCEPTION 'HISTORICAL_RECORD_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Period dates and label are fixed once a version exists';
  END IF;
  IF (NEW.completeness, NEW.reconstruction_status) IS DISTINCT FROM (OLD.completeness, OLD.reconstruction_status)
     AND (NEW.status_reason IS NOT DISTINCT FROM OLD.status_reason OR NEW.status_changed_at IS NOT DISTINCT FROM OLD.status_changed_at) THEN
    RAISE EXCEPTION 'HISTORICAL_STATUS_REASON_REQUIRED' USING ERRCODE = '23514', DETAIL = 'A status change needs a new reason and change time';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_periods_guard BEFORE UPDATE OR DELETE ON historical_periods
  FOR EACH ROW EXECUTE FUNCTION historical_periods_guard();

-- Fingerprint over the version content, its ordered lines and the sha256 of every referenced document.
CREATE FUNCTION historical_version_fingerprint(p_version UUID) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'version', jsonb_build_object(
      'company_id', v.company_id, 'period_id', v.period_id, 'period_start', p.period_start, 'period_end', p.period_end,
      'kind', v.kind, 'statement_type', v.statement_type, 'version_no', v.version_no, 'functional_currency', v.functional_currency,
      'submitted_to', v.submitted_to, 'submission_date', v.submission_date, 'submission_reference', v.submission_reference,
      'proof_level', v.proof_level, 'proof_document_sha256', pd.sha256,
      'internal_purpose', v.internal_purpose, 'basis_version_id', v.basis_version_id, 'basis_fingerprint', b.fingerprint,
      'source_type', v.source_type, 'confidence', v.confidence, 'evidence_reference', v.evidence_reference,
      'evidence_document_sha256', ed.sha256, 'method_note', v.method_note),
    'lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('line_no', l.line_no, 'line_kind', l.line_kind, 'line_code', l.line_code, 'label_ar', l.label_ar,
               'label_en', l.label_en, 'amount', l.amount::text, 'supporting_document_sha256', sd.sha256, 'note', l.note) ORDER BY l.line_no)
        FROM historical_statement_lines l LEFT JOIN documents sd ON sd.id = l.supporting_document_id
       WHERE l.version_id = v.id), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')
  FROM historical_statement_versions v
  JOIN historical_periods p ON p.id = v.period_id
  LEFT JOIN documents pd ON pd.id = v.proof_document_id
  LEFT JOIN documents ed ON ed.id = v.evidence_document_id
  LEFT JOIN historical_statement_versions b ON b.id = v.basis_version_id
  WHERE v.id = p_version
$$;

-- Versions: created as draft; a draft may be edited, sealed or voided; a sealed version changes only its review columns, forward only.
CREATE FUNCTION historical_statement_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  basis historical_statement_versions%ROWTYPE;
  rank_old INT; rank_new INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'HISTORICAL_RECORD_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Historical versions are never deleted (void a draft instead)';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'draft' OR NEW.review_status <> 'none' OR NEW.fingerprint IS NOT NULL THEN
      RAISE EXCEPTION 'HISTORICAL_VERSION_INVALID' USING ERRCODE = '23514', DETAIL = 'A version is created as an unreviewed draft';
    END IF;
  ELSE
    IF OLD.state = 'voided' THEN
      RAISE EXCEPTION 'HISTORICAL_RECORD_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'A voided version is final';
    END IF;
    IF (NEW.id, NEW.company_id, NEW.period_id, NEW.kind, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.company_id, OLD.period_id, OLD.kind, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'HISTORICAL_RECORD_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Version identity cannot change';
    END IF;
    IF OLD.state = 'sealed' THEN
      rank_old := array_position(ARRAY['none', 'reviewed', 'approved'], OLD.review_status);
      rank_new := array_position(ARRAY['none', 'reviewed', 'approved'], NEW.review_status);
      IF (to_jsonb(NEW) - ARRAY['review_status', 'reviewed_by', 'reviewed_at', 'approved_by', 'approved_at'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['review_status', 'reviewed_by', 'reviewed_at', 'approved_by', 'approved_at'])
         OR rank_new < rank_old
         OR (OLD.review_status <> 'none' AND (NEW.reviewed_by, NEW.reviewed_at) IS DISTINCT FROM (OLD.reviewed_by, OLD.reviewed_at))
         OR (OLD.review_status = 'approved' AND (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at)) THEN
        RAISE EXCEPTION 'HISTORICAL_RECORD_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'A sealed version changes only its internal review, forward';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  -- draft (insert or update): the basis must be a sealed version of the same period and statement type
  IF NEW.basis_version_id IS NOT NULL THEN
    SELECT * INTO basis FROM historical_statement_versions WHERE id = NEW.basis_version_id AND company_id = NEW.company_id;
    IF NOT FOUND OR basis.state <> 'sealed' OR basis.period_id <> NEW.period_id OR basis.statement_type <> NEW.statement_type THEN
      RAISE EXCEPTION 'HISTORICAL_BASIS_INVALID' USING ERRCODE = '23514', DETAIL = 'The basis must be a sealed version of the same period and statement';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.state = 'sealed' THEN
    -- Serialise with line edits, require lines, and compute the fingerprint here (any supplied value is replaced).
    PERFORM 1 FROM historical_statement_lines WHERE version_id = NEW.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'HISTORICAL_VERSION_EMPTY' USING ERRCODE = '23514', DETAIL = 'A version is sealed with at least one line';
    END IF;
    NEW.sealed_at := NOW();
    NEW.fingerprint := historical_version_fingerprint(NEW.id);
    -- the stored row is the draft row; fields changed together with sealing must be fingerprinted too
    IF (to_jsonb(NEW) - ARRAY['state', 'sealed_by', 'sealed_at', 'fingerprint'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'sealed_by', 'sealed_at', 'fingerprint']) THEN
      RAISE EXCEPTION 'HISTORICAL_VERSION_INVALID' USING ERRCODE = '23514', DETAIL = 'Sealing changes no content; save the draft first';
    END IF;
  ELSIF NEW.fingerprint IS NOT NULL THEN
    RAISE EXCEPTION 'HISTORICAL_VERSION_INVALID' USING ERRCODE = '23514', DETAIL = 'Only sealing sets the fingerprint';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER historical_statement_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON historical_statement_versions
  FOR EACH ROW EXECUTE FUNCTION historical_statement_versions_guard();

-- Lines change only while their version is a draft (the version row is locked, serialising with sealing).
CREATE FUNCTION historical_statement_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT state INTO st FROM historical_statement_versions WHERE id = OLD.version_id FOR UPDATE;
    IF st IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'HISTORICAL_RECORD_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Lines of a sealed or voided version cannot change';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT state INTO st FROM historical_statement_versions WHERE id = NEW.version_id FOR UPDATE;
    IF st IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'HISTORICAL_RECORD_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'Lines of a sealed or voided version cannot change';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER historical_statement_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON historical_statement_lines
  FOR EACH ROW EXECUTE FUNCTION historical_statement_lines_guard();

-- Documents: the stored file identity of a document referenced by a SEALED historical version is fixed. Deletion is already refused by the
-- RESTRICT foreign keys above (and reported by DocumentService.deleteDocument). Review and intake columns are not affected.
CREATE FUNCTION documents_historical_protection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.company_id, NEW.storage_key, NEW.sha256, NEW.size_bytes, NEW.mime_type, NEW.original_filename)
       IS DISTINCT FROM (OLD.company_id, OLD.storage_key, OLD.sha256, OLD.size_bytes, OLD.mime_type, OLD.original_filename)
     AND (EXISTS (SELECT 1 FROM historical_statement_versions v WHERE v.state = 'sealed' AND (v.proof_document_id = OLD.id OR v.evidence_document_id = OLD.id))
       OR EXISTS (SELECT 1 FROM historical_statement_lines l JOIN historical_statement_versions v ON v.id = l.version_id
                   WHERE l.supporting_document_id = OLD.id AND v.state = 'sealed')) THEN
    RAISE EXCEPTION 'HISTORICAL_DOCUMENT_PROTECTED' USING ERRCODE = '55000', DETAIL = 'The document is evidence for a sealed historical record';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_historical_protection BEFORE UPDATE OF company_id, storage_key, sha256, size_bytes, mime_type, original_filename ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_historical_protection();

-- Registration only: no role_capabilities row, so no default role gains them; Full Access holds them through the wildcard (075).
INSERT INTO capabilities (id) VALUES
  ('historical.view'),
  ('historical.manage'),
  ('historical.approve')
ON CONFLICT (id) DO NOTHING;
