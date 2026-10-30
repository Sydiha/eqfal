-- G6-1: Zakat preparation workflow (eligibility evidence, ownership snapshot, balances snapshot, accountant-confirmed classifications,
-- revisions). No Zakat payable amount is stored or computed here; approval stays blocked while a blocking regulatory gate is unverified.
-- 098 stays reserved. No new capabilities: the existing tax_workpaper.* and partner.ownership.* capabilities authorise these routes.

CREATE TABLE zakat_ownership_eligibility (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL,
  ownership_class TEXT NOT NULL CHECK (ownership_class IN ('saudi_natural','gcc_natural','saudi_entity','gcc_entity','other','unknown')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  evidence_document_id UUID NOT NULL,
  entity_ultimate_ownership_note TEXT CHECK (entity_ultimate_ownership_note IS NULL OR char_length(entity_ultimate_ownership_note) <= 2000),
  verification_status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (verification_status IN ('unconfirmed','confirmed')),
  confirmed_by_user_id UUID REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 1000),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  FOREIGN KEY (partner_id, company_id) REFERENCES partners(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_document_id, company_id) REFERENCES documents(id, company_id) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (verification_status = 'unconfirmed' OR (confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (ownership_class NOT IN ('saudi_entity','gcc_entity') OR btrim(COALESCE(entity_ultimate_ownership_note, '')) <> '')
);
CREATE INDEX zakat_ownership_eligibility_scope_idx ON zakat_ownership_eligibility (company_id, partner_id, effective_from);

-- A confirmed row never overlaps another confirmed row of the same partner and is immutable (a period may only be end-dated once).
CREATE FUNCTION zakat_eligibility_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.verification_status = 'confirmed' THEN RAISE EXCEPTION 'Confirmed Zakat eligibility rows cannot be deleted' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.verification_status = 'confirmed' THEN
    IF NEW.verification_status <> 'confirmed' OR NEW.partner_id <> OLD.partner_id OR NEW.company_id <> OLD.company_id
       OR NEW.ownership_class <> OLD.ownership_class OR NEW.effective_from <> OLD.effective_from
       OR NEW.evidence_document_id <> OLD.evidence_document_id
       OR NEW.entity_ultimate_ownership_note IS DISTINCT FROM OLD.entity_ultimate_ownership_note
       OR NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR (OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to) THEN
      RAISE EXCEPTION 'Confirmed Zakat eligibility rows are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.verification_status = 'confirmed' AND EXISTS (
    SELECT 1 FROM zakat_ownership_eligibility o
    WHERE o.company_id = NEW.company_id AND o.partner_id = NEW.partner_id AND o.id <> NEW.id AND o.verification_status = 'confirmed'
      AND o.effective_from <= COALESCE(NEW.effective_to, DATE '9999-12-31') AND NEW.effective_from <= COALESCE(o.effective_to, DATE '9999-12-31')
  ) THEN
    RAISE EXCEPTION 'Confirmed Zakat eligibility periods of a partner must not overlap' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zakat_eligibility_guard BEFORE INSERT OR UPDATE OR DELETE ON zakat_ownership_eligibility
  FOR EACH ROW EXECUTE FUNCTION zakat_eligibility_guard();

CREATE TABLE zakat_worksheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id UUID NOT NULL,
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','reviewed','approved','superseded')),
  revision_reason TEXT CHECK (revision_reason IS NULL OR char_length(revision_reason) <= 2000),
  supersedes_id UUID,
  non_financing_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  accounting_records_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  ownership_snapshot JSONB,
  ownership_fingerprint TEXT,
  balances_snapshot JSONB,
  balances_fingerprint TEXT,
  snapshot_captured_at TIMESTAMPTZ,
  approved_snapshot JSONB,
  approved_snapshot_fingerprint TEXT,
  prepared_by_user_id UUID NOT NULL REFERENCES users(id),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  approved_by_user_id UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, fiscal_year_id, revision_no),
  FOREIGN KEY (fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (supersedes_id, company_id) REFERENCES zakat_worksheets(id, company_id),
  CHECK (revision_no = 1 OR btrim(COALESCE(revision_reason, '')) <> ''),
  CHECK (status <> 'approved' OR (approved_snapshot IS NOT NULL AND approved_snapshot_fingerprint IS NOT NULL AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL))
);
-- One open revision and one current approved revision per fiscal year; superseded revisions are kept.
CREATE UNIQUE INDEX zakat_worksheets_one_open_idx ON zakat_worksheets (company_id, fiscal_year_id) WHERE status IN ('draft','in_review','reviewed');
CREATE UNIQUE INDEX zakat_worksheets_one_approved_idx ON zakat_worksheets (company_id, fiscal_year_id) WHERE status = 'approved';

CREATE TABLE zakat_account_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worksheet_id UUID NOT NULL,
  account_id UUID NOT NULL,
  zakat_type TEXT NOT NULL CHECK (zakat_type IN (
    'equity_capital','equity_reserve','retained_earnings','carried_forward_loss','treasury_shares',
    'provision_equity_like','provision_eosb_leave','partner_loan_credit_liability','partner_loan_credit_equity',
    'non_current_liability','current_liability',
    'deductible_fixed_asset','deductible_intangible','deductible_spare_or_raw_material','statutory_deposit','deferred_tax_asset','deductible_investment',
    'non_deductible_asset','other_manual')),
  reg_article TEXT NOT NULL CHECK (btrim(reg_article) <> '' AND char_length(reg_article) <= 100),
  evidence_document_id UUID,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 2000),
  confirmed_by_user_id UUID NOT NULL REFERENCES users(id),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (worksheet_id, account_id),
  FOREIGN KEY (worksheet_id, company_id) REFERENCES zakat_worksheets(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (evidence_document_id, company_id) REFERENCES documents(id, company_id) ON DELETE RESTRICT
);

CREATE TABLE zakat_worksheet_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  worksheet_id UUID NOT NULL,
  description TEXT NOT NULL CHECK (btrim(description) <> '' AND char_length(description) <= 500),
  direction TEXT NOT NULL CHECK (direction IN ('add','deduct')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  reg_article TEXT NOT NULL CHECK (btrim(reg_article) <> '' AND char_length(reg_article) <= 100),
  evidence_document_id UUID,
  evidence_note TEXT CHECK (evidence_note IS NULL OR char_length(evidence_note) <= 2000),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  FOREIGN KEY (worksheet_id, company_id) REFERENCES zakat_worksheets(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_document_id, company_id) REFERENCES documents(id, company_id) ON DELETE RESTRICT,
  CHECK (evidence_document_id IS NOT NULL OR btrim(COALESCE(evidence_note, '')) <> '')
);
CREATE INDEX zakat_worksheet_adjustments_scope_idx ON zakat_worksheet_adjustments (company_id, worksheet_id);

-- Only a draft worksheet accepts child changes; approved/superseded/in-review content can never be silently overwritten.
CREATE FUNCTION zakat_worksheet_child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status TEXT; parent_id UUID; parent_company UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN parent_id := OLD.worksheet_id; parent_company := OLD.company_id; ELSE parent_id := NEW.worksheet_id; parent_company := NEW.company_id; END IF;
  SELECT status INTO parent_status FROM zakat_worksheets WHERE id = parent_id AND company_id = parent_company;
  -- parent row already gone (company/fiscal-year cascade): allow the cascading delete
  IF parent_status IS NULL AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF parent_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Zakat worksheet content is locked unless the worksheet is a draft' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zakat_classifications_guard BEFORE INSERT OR UPDATE OR DELETE ON zakat_account_classifications FOR EACH ROW EXECUTE FUNCTION zakat_worksheet_child_guard();
CREATE TRIGGER zakat_adjustments_guard BEFORE INSERT OR UPDATE OR DELETE ON zakat_worksheet_adjustments FOR EACH ROW EXECUTE FUNCTION zakat_worksheet_child_guard();

-- Approved/superseded revisions are immutable apart from the single approved -> superseded transition.
CREATE FUNCTION zakat_worksheet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved','superseded') THEN RAISE EXCEPTION 'Approved Zakat worksheet revisions cannot be deleted' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('approved','superseded') THEN
    IF NOT (OLD.status = 'approved' AND NEW.status = 'superseded'
            AND to_jsonb(NEW) - 'status' - 'version' - 'updated_at' = to_jsonb(OLD) - 'status' - 'version' - 'updated_at') THEN
      RAISE EXCEPTION 'Approved Zakat worksheet revisions are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zakat_worksheet_guard BEFORE UPDATE OR DELETE ON zakat_worksheets FOR EACH ROW EXECUTE FUNCTION zakat_worksheet_guard();

-- Regulatory gates: approval stays blocked while a gate with blocks_approval is unverified. Gates are changed only after a recorded accountant
-- decision (a later, separately authorised data change); there is intentionally no API that flips them.
CREATE TABLE zakat_regulatory_gates (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  article_ref TEXT NOT NULL,
  blocks_approval BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','verified')),
  verified_by_name TEXT,
  verified_on DATE,
  verification_reference TEXT,
  CHECK (status = 'unverified' OR (btrim(COALESCE(verified_by_name, '')) <> '' AND verified_on IS NOT NULL AND btrim(COALESCE(verification_reference, '')) <> ''))
);
INSERT INTO zakat_regulatory_gates (code, title, article_ref, blocks_approval) VALUES
  ('B0_amendment_1248', 'Impact of amending Resolution 1248 on the 1445 regulation', 'Res. 1007/1445, am. 1248/1446', TRUE),
  ('B1_hijri_denominator', 'Number of days of the Hijri year in the Article 15 rate formula', 'Art. 15', FALSE),
  ('B2_saudi_gcc_definition', 'Definition of Saudi/GCC owner and treatment of entity owners', 'Art. 3, 13', FALSE),
  ('B3_rounding', 'Rounding rules for ratios, base, period rate and Zakat due', 'Arts. 15, 25', TRUE),
  ('B4_cap_ordering', 'Order of applying the Art. 23(2) cap with Arts. 25 and 29(2)(b)', 'Arts. 23, 25, 29', TRUE),
  ('B5_max_base_effect', 'Effect of the maximum base when the computed base exceeds it', 'Art. 28', FALSE),
  ('B6_account_mapping_policy', 'Company-level account mapping policy and treatment after closing', 'Art. 17', FALSE),
  ('B7_book_profit_after_zakat', 'Book profit "after Zakat and tax" when no Zakat provision is recorded yet', 'Art. 23(3)', TRUE);
