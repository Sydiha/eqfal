-- Phase 1 authorization policy metadata. This migration tags standard roles but does not
-- activate target policies or alter any role_capabilities / membership rows.
ALTER TABLE roles
  ADD COLUMN authorization_policy_key TEXT,
  ADD COLUMN authorization_policy_version SMALLINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT roles_authorization_policy_key_check CHECK (
    authorization_policy_key IS NULL OR authorization_policy_key IN ('accountant', 'company_manager', 'finance_manager')
  ),
  ADD CONSTRAINT roles_authorization_policy_version_check CHECK (authorization_policy_version IN (0, 1));
ALTER TABLE roles
  ADD CONSTRAINT roles_authorization_policy_pair_check CHECK (
    authorization_policy_version = 0 OR authorization_policy_key IS NOT NULL
  );

ALTER TABLE users
  ADD COLUMN system_admin_policy_version SMALLINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT users_system_admin_policy_version_check CHECK (system_admin_policy_version IN (0, 1));

-- Existing standard-role identity is metadata only. All rows remain on version 0.
UPDATE roles SET authorization_policy_key = 'accountant'
 WHERE is_full_access = FALSE AND name IN ('Accountant', 'accountant');
UPDATE roles SET authorization_policy_key = 'finance_manager'
 WHERE is_full_access = FALSE AND name IN ('Finance Manager', 'finance_manager');
UPDATE roles SET authorization_policy_key = 'company_manager'
 WHERE is_full_access = FALSE AND name = 'Company Manager';

CREATE INDEX roles_authorization_policy_idx
  ON roles (company_id, authorization_policy_key, authorization_policy_version)
  WHERE authorization_policy_key IS NOT NULL;
