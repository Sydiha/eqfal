-- Phase 9A.6: action-specific Company Accounting Profile capabilities.
-- Preserve legacy grants without allowing the legacy capability at runtime.

INSERT INTO capabilities (id)
VALUES
  ('company_accounting_profile.create'),
  ('company_accounting_profile.edit'),
  ('company_accounting_profile.submit')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('company_accounting_profile.create'),
    ('company_accounting_profile.edit'),
    ('company_accounting_profile.submit')
) AS granular(id)
WHERE rc.capability_id = 'company_accounting_profile.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;
