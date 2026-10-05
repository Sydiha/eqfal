-- Wave 1 / Task 4: Audit Log viewer capability.
-- Data-only: registers the read capability. Full Access roles receive every registered
-- capability implicitly; no role_capabilities rows are granted here (explicit grants
-- are made by administrators through Users & Permissions, subject to the ceiling rule).
-- The audit_log table itself is unchanged and stays append-only.

INSERT INTO capabilities (id)
VALUES ('audit.view')
ON CONFLICT (id) DO NOTHING;
