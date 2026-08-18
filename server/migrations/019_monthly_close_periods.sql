-- Phase 5A: monthly close foundation. Readiness remains computed at runtime.
INSERT INTO capabilities (id)
VALUES ('monthly_close.close'), ('monthly_close.reopen')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE fiscal_years
  ADD CONSTRAINT fiscal_years_id_company_uidx UNIQUE (id, company_id);

CREATE TABLE monthly_close_periods (
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

CREATE INDEX monthly_close_periods_company_dates_idx
  ON monthly_close_periods (company_id, period_start, period_end);
