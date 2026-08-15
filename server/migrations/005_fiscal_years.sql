-- Migration 005: fiscal years
--
-- fiscal_years: scoped per company. A company may have many fiscal years,
--   but their date ranges must not overlap within the same company.
--   Fiscal years in different companies are fully independent.
--
-- status: 'open' | 'closed' only (no reopen workflow in this iteration).
--
-- Date validity (start_date < end_date) is enforced by CHECK constraint.
-- Overlap prevention is enforced at the application (service) layer.
-- Cross-company isolation is enforced at the repository + service layer:
--   every read/write includes company_id in the WHERE clause.

CREATE TABLE fiscal_years (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  start_date  DATE        NOT NULL,
  end_date    DATE        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT  fiscal_years_date_order CHECK (start_date < end_date)
);

CREATE INDEX fiscal_years_company_idx ON fiscal_years (company_id);
