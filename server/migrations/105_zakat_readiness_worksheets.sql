-- G6-1: Zakat readiness workflow (eligibility evidence, ownership snapshots, worksheet revisions, classifications, adjustments).
-- No payable amount is stored or computed anywhere in these tables: final Zakat calculation stays blocked (B3, B4, B7, amendment 1248).
-- Migration 098 is reserved and intentionally not used. Existing tax_working_papers rows and VAT/WHT tables are untouched.

-- 1. Effective-dated ownership eligibility with mandatory evidence. Absence of a record means "unknown" (never inferred).
CREATE TABLE zakat_partner_eligibility (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL,
  ownership_class TEXT NOT NULL CHECK (ownership_class IN ('saudi_natural','gcc_natural','saudi_entity_confirmed','gcc_entity_confirmed','other')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  evidence_document_id UUID NOT NULL,
  ultimate_ownership_note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  confirmed_by_user_id UUID NOT NULL REFERENCES users(id),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by_user_id UUID REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  FOREIGN KEY (partner_id, company_id) REFERENCES partners(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_document_id, company_id) REFERENCES documents(id, company_id) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (ownership_class NOT IN ('saudi_entity_confirmed','gcc_entity_confirmed') OR (ultimate_ownership_note IS NOT NULL AND btrim(ultimate_ownership_note) <> '')),
  CHECK (status = 'active' OR (revoked_by_user_id IS NOT NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL AND btrim(revoke_reason) <> ''))
);
CREATE INDEX zakat_partner_eligibility_scope_idx ON zakat_partner_eligibility (company_id, partner_id, effective_from);

-- 2. Fiscal-year-end ownership verification snapshots (immutable).
CREATE TABLE zakat_ownership_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id UUID NOT NULL,
  snapshot_date DATE NOT NULL,
  qualified BOOLEAN NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  detail JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  captured_by_user_id UUID NOT NULL REFERENCES users(id),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  FOREIGN KEY (fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE CASCADE,
  CHECK (qualified = (jsonb_array_length(reasons) = 0))
);
CREATE INDEX zakat_ownership_snapshots_scope_idx ON zakat_ownership_snapshots (company_id, fiscal_year_id, captured_at DESC);

-- 3. Worksheet revisions. One in-progress revision and at most one approved revision per workpaper; approved content never changes.
CREATE TABLE zakat_worksheet_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id UUID NOT NULL,
  workpaper_id UUID NOT NULL,
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','needs_review','reviewed','approved','superseded')),
  revision_reason TEXT,
  supersedes_id UUID,
  non_financing_entity_declared BOOLEAN NOT NULL CHECK (non_financing_entity_declared),
  ownership_snapshot_id UUID,
  balance_snapshot JSONB NOT NULL,
  balance_fingerprint TEXT NOT NULL,
  balance_captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prepared_by_user_id UUID NOT NULL REFERENCES users(id),
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  approved_by_user_id UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  approved_snapshot JSONB,
  approved_fingerprint TEXT,
  superseded_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (workpaper_id, revision_no),
  FOREIGN KEY (fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (workpaper_id, company_id) REFERENCES tax_working_papers(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (ownership_snapshot_id, company_id) REFERENCES zakat_ownership_snapshots(id, company_id),
  FOREIGN KEY (supersedes_id, company_id) REFERENCES zakat_worksheet_revisions(id, company_id),
  CHECK (revision_no = 1 OR (revision_reason IS NOT NULL AND btrim(revision_reason) <> '')),
  CHECK (revision_no = 1 OR supersedes_id IS NOT NULL),
  CHECK (status NOT IN ('approved','superseded') OR (approved_snapshot IS NOT NULL AND approved_fingerprint IS NOT NULL AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE UNIQUE INDEX zakat_one_in_progress_revision ON zakat_worksheet_revisions (workpaper_id) WHERE status IN ('draft','needs_review','reviewed');
CREATE UNIQUE INDEX zakat_one_approved_revision ON zakat_worksheet_revisions (workpaper_id) WHERE status = 'approved';
CREATE INDEX zakat_worksheet_revisions_scope_idx ON zakat_worksheet_revisions (company_id, fiscal_year_id, revision_no DESC);

-- 4. Accountant-confirmed account classifications (per revision, so history is preserved).
CREATE TABLE zakat_revision_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL,
  account_id UUID NOT NULL,
  zakat_class TEXT NOT NULL CHECK (zakat_class IN (
    'addition_equity','addition_provision_equity','addition_non_current_liability','addition_provision_non_current_liability',
    'addition_partner_loan_equity','addition_partner_loan_liability','current_liability',
    'deduction_fixed_assets','deduction_intangibles','deduction_other_article','not_deducted','not_deducted_inventory','investment_unsupported')),
  reg_article TEXT,
  evidence_document_id UUID,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','confirmed')),
  confirmed_by_user_id UUID REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (revision_id, account_id),
  FOREIGN KEY (revision_id, company_id) REFERENCES zakat_worksheet_revisions(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_document_id, company_id) REFERENCES documents(id, company_id) ON DELETE RESTRICT,
  CHECK (status = 'suggested' OR (reg_article IS NOT NULL AND btrim(reg_article) <> '' AND confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (status = 'suggested' OR zakat_class NOT IN ('addition_provision_equity','addition_provision_non_current_liability','addition_partner_loan_liability','deduction_fixed_assets','deduction_intangibles','deduction_other_article') OR evidence_document_id IS NOT NULL)
);

-- 5. Profit adjustment details (revision-scoped; regulatory article and evidence are mandatory).
CREATE TABLE zakat_revision_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL,
  description TEXT NOT NULL CHECK (btrim(description) <> ''),
  direction TEXT NOT NULL CHECK (direction IN ('add','deduct')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  reg_article TEXT NOT NULL CHECK (btrim(reg_article) <> ''),
  evidence_document_id UUID NOT NULL,
  note TEXT,
  professional_review_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  FOREIGN KEY (revision_id, company_id) REFERENCES zakat_worksheet_revisions(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_document_id, company_id) REFERENCES documents(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX zakat_revision_adjustments_scope_idx ON zakat_revision_adjustments (company_id, revision_id);

-- 6. Immutability guards.
CREATE FUNCTION zakat_ownership_snapshots_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'zakat_ownership_snapshots rows are immutable' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER zakat_ownership_snapshots_no_change BEFORE UPDATE OR DELETE ON zakat_ownership_snapshots
  FOR EACH ROW EXECUTE FUNCTION zakat_ownership_snapshots_immutable();

CREATE FUNCTION zakat_eligibility_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'zakat_partner_eligibility rows cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF OLD.status = 'revoked' THEN RAISE EXCEPTION 'revoked eligibility records are immutable' USING ERRCODE = '23514'; END IF;
  IF NEW.status <> 'revoked' OR (NEW.partner_id, NEW.company_id, NEW.ownership_class, NEW.effective_from, NEW.effective_to, NEW.evidence_document_id, NEW.ultimate_ownership_note, NEW.confirmed_by_user_id, NEW.confirmed_at)
     IS DISTINCT FROM (OLD.partner_id, OLD.company_id, OLD.ownership_class, OLD.effective_from, OLD.effective_to, OLD.evidence_document_id, OLD.ultimate_ownership_note, OLD.confirmed_by_user_id, OLD.confirmed_at) THEN
    RAISE EXCEPTION 'eligibility records may only be revoked, not edited' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zakat_eligibility_no_edit BEFORE UPDATE OR DELETE ON zakat_partner_eligibility
  FOR EACH ROW EXECUTE FUNCTION zakat_eligibility_guard();

CREATE FUNCTION zakat_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved','superseded') THEN RAISE EXCEPTION 'approved Zakat revisions cannot be deleted' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('approved','superseded') THEN
    IF NEW.status NOT IN ('approved','superseded') OR (OLD.status = 'superseded' AND NEW.status <> 'superseded')
       OR NEW.approved_snapshot IS DISTINCT FROM OLD.approved_snapshot OR NEW.approved_fingerprint IS DISTINCT FROM OLD.approved_fingerprint
       OR NEW.balance_snapshot IS DISTINCT FROM OLD.balance_snapshot OR NEW.balance_fingerprint IS DISTINCT FROM OLD.balance_fingerprint
       OR NEW.ownership_snapshot_id IS DISTINCT FROM OLD.ownership_snapshot_id OR NEW.revision_reason IS DISTINCT FROM OLD.revision_reason
       OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'approved Zakat revisions are immutable (only supersession is allowed)' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zakat_revision_immutable BEFORE UPDATE OR DELETE ON zakat_worksheet_revisions
  FOR EACH ROW EXECUTE FUNCTION zakat_revision_guard();

CREATE FUNCTION zakat_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rev_status TEXT; rev UUID;
BEGIN
  rev := CASE WHEN TG_OP = 'DELETE' THEN OLD.revision_id ELSE NEW.revision_id END;
  SELECT status INTO rev_status FROM zakat_worksheet_revisions WHERE id = rev;
  IF rev_status IN ('approved','superseded') THEN
    RAISE EXCEPTION 'rows of an approved Zakat revision are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER zakat_classifications_guard BEFORE INSERT OR UPDATE OR DELETE ON zakat_revision_classifications
  FOR EACH ROW EXECUTE FUNCTION zakat_child_guard();
CREATE TRIGGER zakat_adjustments_guard BEFORE INSERT OR UPDATE OR DELETE ON zakat_revision_adjustments
  FOR EACH ROW EXECUTE FUNCTION zakat_child_guard();
