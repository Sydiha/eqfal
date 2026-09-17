-- Wave A / A5: action-specific Tax/Zakat working-paper capabilities.
-- Preserve legacy grants while removing their use as runtime authorization fallbacks.

INSERT INTO capabilities (id)
VALUES
  ('tax_workpaper.create'),
  ('tax_workpaper.edit'),
  ('tax_workpaper.adjustment.create'),
  ('tax_workpaper.adjustment.edit'),
  ('tax_workpaper.adjustment.delete'),
  ('tax_workpaper.submit')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('tax_workpaper.create'),
    ('tax_workpaper.edit'),
    ('tax_workpaper.adjustment.create'),
    ('tax_workpaper.adjustment.edit'),
    ('tax_workpaper.adjustment.delete'),
    ('tax_workpaper.submit')
) AS granular(id)
WHERE rc.capability_id = 'tax_workpaper.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;
