-- Migration 002: Companies table
-- Core tenancy anchor — every future business entity references this table
-- via a company_id foreign key. Users, memberships, fiscal years, and all
-- financial records belong to exactly one company.
--
-- NOT included here: users, memberships, roles, capabilities, fiscal years,
-- or any operational business tables. Those come in later migrations.

CREATE TABLE IF NOT EXISTS companies (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  name_ar    TEXT,
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS companies_slug_uq ON companies (slug);
