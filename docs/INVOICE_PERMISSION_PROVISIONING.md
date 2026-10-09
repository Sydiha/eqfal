# Invoice permission provisioning (owner-authorized procedure, NOT executed)

`invoice.view`, `invoice.create`, `invoice.edit` and `invoice.submit` (migration 064) are explicit-grant-only (migration 063,
`capabilities.implicit_full_access = FALSE`). No role, including Full Access, holds them after the migration.
The role-management API cannot grant them either: the ceiling rule requires the granter to already hold the
capability, and Full Access roles are immutable. The first grant therefore happens outside the application, by
the Project Owner's explicit decision, per company.

## Procedure (run only after written Owner approval naming the company and the role)
1. Identify the target `roles.id` of the company (`SELECT id, name FROM roles WHERE company_id = '<company>'`).
2. Insert only the approved capabilities, in one transaction, and record the change in the audit log:
   `INSERT INTO role_capabilities (role_id, capability_id) VALUES ('<role>', 'invoice.view') ON CONFLICT DO NOTHING;`
3. Verify with a new session for a member of that role: `GET /api/auth/session` lists exactly the approved capabilities.
4. After the first holder exists, further delegation inside that company uses the normal Users & Permissions screen
   (a holder can pass on only what they hold, and also needs `access.role.capability.grant`).

## Rollback
`DELETE FROM role_capabilities WHERE capability_id LIKE 'invoice.%' AND role_id = '<role>';`
Full removal of the feature flag: `DELETE FROM capabilities WHERE id LIKE 'invoice.%'; ALTER TABLE capabilities DROP COLUMN implicit_full_access;`
(only after the two capability-resolution queries are reverted).

Never run against Production or Staging without explicit Owner approval.
