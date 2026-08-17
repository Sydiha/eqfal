-- Migration 016: Phase 4A partners registry and ownership history
INSERT INTO capabilities (id) VALUES ('partner.view'), ('partner.manage') ON CONFLICT (id) DO NOTHING;

CREATE TABLE partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, company_id)
);
CREATE INDEX partners_company_list_idx ON partners (company_id, is_active DESC, name, created_at DESC);

CREATE TABLE partner_ownership_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL,
  ownership_percentage NUMERIC(7,4),
  effective_from DATE,
  effective_to DATE,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('unconfirmed','confirmed')),
  source_document_id UUID,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 1000),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, company_id),
  FOREIGN KEY (partner_id, company_id) REFERENCES partners(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_document_id, company_id) REFERENCES documents(id, company_id) ON DELETE RESTRICT,
  CHECK (ownership_percentage IS NULL OR (ownership_percentage > 0 AND ownership_percentage <= 100)),
  CHECK (effective_to IS NULL OR (effective_from IS NOT NULL AND effective_to >= effective_from)),
  CHECK (verification_status = 'unconfirmed' OR (ownership_percentage IS NOT NULL AND effective_from IS NOT NULL))
);
CREATE INDEX partner_ownership_company_partner_idx ON partner_ownership_periods (company_id, partner_id, effective_from DESC NULLS LAST, created_at DESC);
CREATE INDEX partner_ownership_document_idx ON partner_ownership_periods (company_id, source_document_id) WHERE source_document_id IS NOT NULL;
