-- Phase 9A.4: split broad fixed-asset management authority into action-specific capabilities.
-- Preserve existing effective access by backfilling every role that currently holds asset.manage.

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
