-- Wave A / A4: action-specific Opening Balance capabilities.
-- Preserve legacy grants while removing their use as runtime authorization fallbacks.

INSERT INTO capabilities (id)
VALUES
  ('opening_balance.item.create'),
  ('opening_balance.item.edit'),
  ('opening_balance.item.delete'),
  ('opening_balance.submit')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('opening_balance.item.create'),
    ('opening_balance.item.edit'),
    ('opening_balance.item.delete')
) AS granular(id)
WHERE rc.capability_id = 'opening_balance.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, 'opening_balance.submit'
FROM role_capabilities rc
WHERE rc.capability_id = 'opening_balance.review'
ON CONFLICT (role_id, capability_id) DO NOTHING;
