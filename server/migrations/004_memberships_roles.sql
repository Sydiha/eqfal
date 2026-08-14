-- Migration 004: memberships, roles, capabilities
--
-- capabilities: operational action labels, company-agnostic.
--   No FK to companies — they are global identifiers (e.g. 'invoice.create').
--
-- roles: scoped per company. A role in company A is entirely distinct from
--   a role with the same name in company B.
--
-- role_capabilities: which capabilities a role grants (junction table).
--
-- memberships: binds a user to a company. One membership per user per company
--   (UNIQUE constraint). is_active = false disables the membership without
--   disabling the user account. role_id is nullable (member without a role).
--
-- Cross-company rule enforced at application layer:
--   role_id must reference a role whose company_id = memberships.company_id.

CREATE TABLE capabilities (
  id          TEXT        PRIMARY KEY  -- e.g. 'invoice.create', 'report.view'
);

CREATE TABLE roles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE TABLE role_capabilities (
  role_id       UUID  NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  capability_id TEXT  NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, capability_id)
);

CREATE TABLE memberships (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id     UUID        REFERENCES roles(id) ON DELETE SET NULL,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One membership per user per company
  UNIQUE (user_id, company_id)
);

CREATE INDEX memberships_company_idx ON memberships (company_id);
CREATE INDEX memberships_user_idx    ON memberships (user_id);
