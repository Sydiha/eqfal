-- Phase 7A correction: grant Tax/Zakat working-paper access to company admin roles.
-- Roles remain company-scoped; the global capabilities are assigned through the
-- existing role_capabilities junction table.
INSERT INTO role_capabilities (role_id, capability_id)
SELECT r.id, capability.id
FROM roles r
CROSS JOIN (
  VALUES
    ('tax_workpaper.view'),
    ('tax_workpaper.manage'),
    ('tax_workpaper.review'),
    ('tax_workpaper.approve')
) AS capability(id)
WHERE LOWER(BTRIM(r.name)) = 'admin'
ON CONFLICT (role_id, capability_id) DO NOTHING;
