-- Migration 063 (PR-2A): explicit-grant-only capabilities and the invoice.view/create/edit registrations.
-- Until now a Full Access role resolved EVERY registered capability. The new flag lets a capability opt out of that:
-- when capabilities.implicit_full_access is FALSE, no role (Full Access included) holds it unless a role_capabilities
-- row names it. All existing capabilities default to TRUE, so their behavior is unchanged.
-- No role_capabilities rows are inserted here: invoice permissions start unassigned in every company.
-- Initial provisioning is a separate owner-authorized step (see docs/INVOICE_PERMISSION_PROVISIONING.md).
-- Rollback: DELETE FROM capabilities WHERE id LIKE 'invoice.%' (cascades any explicit grants), then
-- ALTER TABLE capabilities DROP COLUMN implicit_full_access.

ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS implicit_full_access BOOLEAN NOT NULL DEFAULT TRUE;

INSERT INTO capabilities (id, implicit_full_access) VALUES
  ('invoice.view', FALSE),
  ('invoice.create', FALSE),
  ('invoice.edit', FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access = FALSE;
