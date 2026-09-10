-- Phase 6B4: immutable approved VAT return snapshots and filing records.
CREATE TABLE vat_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  vat_period_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','filed')),
  snapshot_json JSONB,
  approved_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  filed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  filed_at TIMESTAMPTZ,
  filing_reference TEXT,
  filing_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (id, company_id),
  UNIQUE (company_id, vat_period_id),
  FOREIGN KEY (vat_period_id, company_id)
    REFERENCES vat_periods(id, company_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'draft' AND snapshot_json IS NULL AND approved_by_user_id IS NULL AND approved_at IS NULL
      AND filed_by_user_id IS NULL AND filed_at IS NULL AND filing_reference IS NULL AND filing_note IS NULL)
    OR
    (status = 'approved' AND snapshot_json IS NOT NULL AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
      AND filed_by_user_id IS NULL AND filed_at IS NULL AND filing_reference IS NULL AND filing_note IS NULL)
    OR
    (status = 'filed' AND snapshot_json IS NOT NULL AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
      AND filed_by_user_id IS NOT NULL AND filed_at IS NOT NULL AND filing_reference IS NOT NULL AND length(btrim(filing_reference)) > 0)
  )
);

CREATE INDEX vat_returns_company_created_idx ON vat_returns (company_id, created_at DESC);

CREATE FUNCTION protect_vat_return_record() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved','filed') AND NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json THEN
    RAISE EXCEPTION 'Approved VAT return snapshot is immutable';
  END IF;
  IF OLD.status = 'filed' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Filed VAT return is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER vat_return_immutability_guard
BEFORE UPDATE ON vat_returns
FOR EACH ROW EXECUTE FUNCTION protect_vat_return_record();
