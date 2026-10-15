-- Migration 075: owner-approved access model (2026-10-15).
--
-- 1. Full Access is a true wildcard. Every registered capability, current and future, resolves for a Full Access role
--    in its company. The explicit-only exception (implicit_full_access = FALSE, migrations 063-073) is removed. The column
--    stays for compatibility, but it must be TRUE, so the exception cannot come back by accident. The application no
--    longer reads it. Existing role_capabilities rows are kept unchanged, so a later rollback loses no data.
-- 2. access.full_access.grant: the explicit, company-scoped authority to grant, demote or manage Full Access. Full Access
--    holds it through the wildcard. A Company Manager holds it only when someone grants it on purpose.
-- 3. users.is_system_admin: the global System Admin marker, separate from company roles. Nobody is promoted here. The
--    first System Admin is set by the explicit one-time CLI (npm run -w server bootstrap:system-admin) after separate
--    owner approval. A trigger keeps at least one active System Admin once one exists.
-- 4. system_audit_log: append-only audit for global actions that have no single company: System Admin grant or revoke,
--    user enable or disable, and the bootstrap. Company-scoped changes keep going to audit_log.
-- 5. Default "Company Manager" role for every existing company that has no role with that name. It holds view,
--    operational-document and access-administration capabilities only. No manual journal create, edit or post, no
--    fiscal-year or period closing or reopening, no tax or VAT final approval, no document approvals, and no Full
--    Access grant. Custom roles and existing grants are not touched. Idempotent.
--
-- Rollback (manual, Owner-approved only): DROP TRIGGER users_last_system_admin_guard ON users; DROP FUNCTION
-- guard_last_system_admin(); DROP TABLE system_audit_log; ALTER TABLE users DROP COLUMN is_system_admin;
-- ALTER TABLE capabilities DROP CONSTRAINT capabilities_full_access_wildcard; DELETE FROM capabilities WHERE
-- id = 'access.full_access.grant'; then DELETE the "Company Manager" roles that no membership uses.

-- 1. Full Access wildcard
UPDATE capabilities SET implicit_full_access = TRUE WHERE implicit_full_access = FALSE;
ALTER TABLE capabilities ALTER COLUMN implicit_full_access SET DEFAULT TRUE;
ALTER TABLE capabilities ADD CONSTRAINT capabilities_full_access_wildcard CHECK (implicit_full_access = TRUE);

-- 2. Delegable Full Access authority
INSERT INTO capabilities (id) VALUES ('access.full_access.grant') ON CONFLICT (id) DO NOTHING;

-- 3. Global System Admin marker
ALTER TABLE users ADD COLUMN is_system_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION guard_last_system_admin() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system_admin AND OLD.is_active
       AND NOT EXISTS (SELECT 1 FROM users WHERE id <> OLD.id AND is_system_admin AND is_active) THEN
      RAISE EXCEPTION 'the last active System Admin cannot be removed' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_system_admin AND OLD.is_active AND NOT (NEW.is_system_admin AND NEW.is_active)
     AND NOT EXISTS (SELECT 1 FROM users WHERE id <> OLD.id AND is_system_admin AND is_active) THEN
    RAISE EXCEPTION 'the last active System Admin cannot be removed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_last_system_admin_guard
  BEFORE UPDATE OF is_system_admin, is_active OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION guard_last_system_admin();

-- 4. Global, append-only audit
CREATE TABLE system_audit_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   UUID        REFERENCES users(id),           -- NULL only for the bootstrap CLI (no session)
  actor_label     TEXT,                                       -- e.g. 'bootstrap-cli'
  action          TEXT        NOT NULL,
  target_user_id  UUID        REFERENCES users(id),
  company_id      UUID        REFERENCES companies(id),
  before_data     JSONB,
  after_data      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT system_audit_log_actor_check CHECK (actor_user_id IS NOT NULL OR actor_label IS NOT NULL)
);
CREATE INDEX system_audit_log_target_idx ON system_audit_log (target_user_id);
CREATE INDEX system_audit_log_created_at_idx ON system_audit_log (created_at);

CREATE OR REPLACE FUNCTION forbid_system_audit_log_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'system_audit_log is append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER system_audit_log_append_only
  BEFORE UPDATE OR DELETE ON system_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_system_audit_log_change();

-- 5. Default Company Manager role (kept in sync with COMPANY_MANAGER_CAPABILITIES in default-role-capabilities.ts;
--    a contract test asserts exact set equality).
WITH manager_caps(capability_id) AS (
  VALUES
    ('access.membership.create'), ('access.membership.role.assign'), ('access.membership.status.edit'),
    ('access.role.capability.grant'), ('access.role.capability.revoke'), ('access.role.create'), ('access.view'),
    ('accounting.view'), ('annual_close.package.view'), ('annual_close.view'), ('asset.view'), ('audit.view'),
    ('bank.view'), ('company.view'), ('company_accounting_profile.view'), ('counterparty.create'), ('counterparty.edit'),
    ('custody.view'), ('document.edit'), ('document.upload'), ('document.view'), ('fiscal_year.view'),
    ('invoice.create'), ('invoice.edit'), ('invoice.recurring'), ('invoice.submit'), ('invoice.view'),
    ('monthly_close.view'), ('obligation.view'), ('opening_balance.view'), ('partner.view'),
    ('periodic_adjustment.view'), ('report.view'), ('tax_workpaper.view'), ('vat.view'), ('wht_review.view')
),
new_roles AS (
  INSERT INTO roles (company_id, name, is_full_access)
  SELECT c.id, 'Company Manager', FALSE
  FROM companies c
  WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.company_id = c.id AND r.name = 'Company Manager')
  RETURNING id
)
INSERT INTO role_capabilities (role_id, capability_id)
SELECT nr.id, mc.capability_id
FROM new_roles nr
JOIN manager_caps mc ON TRUE
JOIN capabilities cap ON cap.id = mc.capability_id
ON CONFLICT DO NOTHING;
