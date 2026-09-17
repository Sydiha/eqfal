-- Phase 9A.7: action-specific Periodic Adjustments capabilities.
-- Preserve legacy grants without allowing the legacy manage capability at runtime.

INSERT INTO capabilities (id)
VALUES
  ('periodic_adjustment.create'),
  ('periodic_adjustment.edit'),
  ('periodic_adjustment.submit')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('periodic_adjustment.create'),
    ('periodic_adjustment.edit')
) AS granular(id)
WHERE rc.capability_id = 'periodic_adjustment.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, 'periodic_adjustment.submit'
FROM role_capabilities rc
WHERE rc.capability_id = 'periodic_adjustment.review'
ON CONFLICT (role_id, capability_id) DO NOTHING;
