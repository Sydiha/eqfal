-- Phase 9A.5: action-specific accounting capabilities.
-- Preserve the effective authority of roles that held broad compatibility grants.

INSERT INTO capabilities (id)
VALUES
  ('accounting.chart.create'),
  ('accounting.chart.edit'),
  ('accounting.journal.create'),
  ('accounting.journal.edit')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('accounting.chart.create'),
    ('accounting.chart.edit')
) AS granular(id)
WHERE rc.capability_id = 'accounting.chart.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('accounting.journal.create'),
    ('accounting.journal.edit')
) AS granular(id)
WHERE rc.capability_id = 'accounting.journal.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;
