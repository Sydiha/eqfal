-- Phase 7A: governed Tax/Zakat working-paper foundation.
INSERT INTO capabilities (id) VALUES
  ('tax_workpaper.view'), ('tax_workpaper.manage'),
  ('tax_workpaper.review'), ('tax_workpaper.approve')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE fiscal_years ADD CONSTRAINT fiscal_years_id_company_unique UNIQUE (id, company_id);

CREATE TABLE tax_working_papers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id UUID NOT NULL,
  accounting_profile_id UUID,
  tax_path TEXT NOT NULL CHECK (tax_path IN ('zakat','income_tax','mixed','needs_review')),
  workflow_status TEXT NOT NULL DEFAULT 'draft' CHECK (workflow_status IN ('draft','needs_review','reviewed','approved')),
  notes TEXT,
  professional_review_required BOOLEAN NOT NULL DEFAULT FALSE,
  prepared_by_user_id UUID NOT NULL REFERENCES users(id), prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by_user_id UUID REFERENCES users(id), reviewed_at TIMESTAMPTZ,
  approved_by_user_id UUID REFERENCES users(id), approved_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, fiscal_year_id), UNIQUE (id, company_id),
  FOREIGN KEY (fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (accounting_profile_id, company_id) REFERENCES company_accounting_profiles(id, company_id)
);

CREATE TABLE tax_working_paper_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  workpaper_id UUID NOT NULL,
  description TEXT NOT NULL CHECK (btrim(description) <> ''),
  direction TEXT NOT NULL CHECK (direction IN ('add','deduct')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  notes TEXT, source_reference TEXT,
  professional_review_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  FOREIGN KEY (workpaper_id, company_id) REFERENCES tax_working_papers(id, company_id) ON DELETE CASCADE
);

CREATE INDEX tax_workpaper_adjustments_scope_idx ON tax_working_paper_adjustments(company_id, workpaper_id);
