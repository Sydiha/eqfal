-- Wave A / A6: action-specific Annual Close Package capabilities.
-- Preserve legacy grants while removing their use from production runtime authorization.

INSERT INTO capabilities (id)
VALUES
  ('annual_close.package.create'),
  ('annual_close.package.snapshot.create')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('annual_close.package.create'),
    ('annual_close.package.snapshot.create')
) AS granular(id)
WHERE rc.capability_id = 'annual_close.package.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;
