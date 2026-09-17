-- Phase 9A.4: action-specific fixed-asset capabilities.
-- Preserve the effective authority of roles that held the broad compatibility grant.

INSERT INTO capabilities (id)
VALUES
  ('asset.create'),
  ('asset.edit'),
  ('asset.cancel'),
  ('asset.policy.manage')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('asset.create'),
    ('asset.edit'),
    ('asset.cancel'),
    ('asset.policy.manage')
) AS granular(id)
WHERE rc.capability_id = 'asset.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;
