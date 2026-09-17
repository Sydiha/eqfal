-- Wave A / A2: action-specific Obligations and Counterparties capabilities.
-- Preserve legacy grants for history while authorizing runtime actions granularly.

INSERT INTO capabilities (id)
VALUES
  ('counterparty.create'),
  ('counterparty.edit'),
  ('counterparty.disable'),
  ('obligation.create'),
  ('obligation.edit'),
  ('obligation.cancel'),
  ('obligation.settlement.create'),
  ('obligation.settlement.remove')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('counterparty.create'),
    ('counterparty.edit'),
    ('counterparty.disable'),
    ('obligation.create'),
    ('obligation.edit'),
    ('obligation.cancel')
) AS granular(id)
WHERE rc.capability_id = 'obligation.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('obligation.settlement.create'),
    ('obligation.settlement.remove')
) AS granular(id)
WHERE rc.capability_id = 'obligation.settle'
ON CONFLICT (role_id, capability_id) DO NOTHING;
