-- Phase 6A: VAT period and manual document VAT review foundation.
INSERT INTO capabilities (id)
VALUES ('vat.view'), ('vat.review'), ('vat.close'), ('vat.reopen')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE vat_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id UUID NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, period_start, period_end),
  FOREIGN KEY (fiscal_year_id, company_id)
    REFERENCES fiscal_years(id, company_id) ON DELETE RESTRICT,
  CHECK (period_end >= period_start)
);

CREATE INDEX vat_periods_company_dates_idx
  ON vat_periods (company_id, period_start, period_end);

CREATE FUNCTION reject_overlapping_vat_periods() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM vat_periods p
    WHERE p.company_id = NEW.company_id
      AND p.id <> NEW.id
      AND p.period_start <= NEW.period_end
      AND p.period_end >= NEW.period_start
  ) THEN
    RAISE EXCEPTION 'VAT period overlaps an existing period' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER vat_period_overlap_guard
BEFORE INSERT OR UPDATE OF company_id, period_start, period_end ON vat_periods
FOR EACH ROW EXECUTE FUNCTION reject_overlapping_vat_periods();

CREATE TABLE document_vat_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id UUID NOT NULL,
  tax_date DATE NOT NULL,
  treatment TEXT CHECK (treatment IS NULL OR treatment IN ('standard', 'zero_rated', 'exempt', 'out_of_scope')),
  taxable_amount NUMERIC(18,2) CHECK (taxable_amount IS NULL OR taxable_amount >= 0),
  vat_amount NUMERIC(18,2) CHECK (vat_amount IS NULL OR vat_amount >= 0),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'reviewed')),
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, company_id),
  UNIQUE (document_id),
  FOREIGN KEY (document_id, company_id)
    REFERENCES documents(id, company_id) ON DELETE RESTRICT,
  CHECK (
    (review_status = 'pending' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL)
    OR
    (review_status = 'reviewed' AND treatment IS NOT NULL AND taxable_amount IS NOT NULL AND vat_amount IS NOT NULL AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX document_vat_reviews_company_tax_date_idx
  ON document_vat_reviews (company_id, tax_date);
