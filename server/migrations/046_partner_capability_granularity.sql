-- Wave A / A3: action-specific Partners capabilities.
-- Preserve the legacy partner.manage grant for history while backfilling all writes.

INSERT INTO capabilities (id)
VALUES
  ('partner.create'),
  ('partner.edit'),
  ('partner.disable'),
  ('partner.ownership.create'),
  ('partner.ownership.edit'),
  ('partner.ownership.confirm')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('partner.create'),
    ('partner.edit'),
    ('partner.disable'),
    ('partner.ownership.create'),
    ('partner.ownership.edit'),
    ('partner.ownership.confirm')
) AS granular(id)
WHERE rc.capability_id = 'partner.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;
