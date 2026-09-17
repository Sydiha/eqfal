-- Phase 9 closure: split broad access administration authority into action-specific capabilities.
-- Preserve legacy access.manage grants for history/backward-compatible role access, but runtime
-- authorization must use only the granular capabilities below.

INSERT INTO capabilities (id)
VALUES
  ('access.view'),
  ('access.membership.create'),
  ('access.membership.status.edit'),
  ('access.membership.role.assign'),
  ('access.role.create'),
  ('access.role.capability.grant'),
  ('access.role.capability.revoke')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('access.view'),
    ('access.membership.create'),
    ('access.membership.status.edit'),
    ('access.membership.role.assign'),
    ('access.role.create'),
    ('access.role.capability.grant'),
    ('access.role.capability.revoke')
) AS granular(id)
WHERE rc.capability_id = 'access.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;
