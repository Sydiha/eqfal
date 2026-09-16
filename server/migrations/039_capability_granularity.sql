-- Phase 9A.2: granular operational capabilities for fiscal-year and monthly-close actions.
-- Existing broad capabilities remain as compatibility identifiers, but current holders are
-- backfilled with the action-specific capabilities so runtime authorization can move to
-- the finer-grained model without silently removing existing access.

INSERT INTO capabilities (id)
VALUES
  ('fiscal_year.create'),
  ('fiscal_year.edit'),
  ('fiscal_year.close'),
  ('monthly_close.view'),
  ('monthly_close.create')
ON CONFLICT (id) DO NOTHING;

-- Preserve effective authority for roles that previously held the broad fiscal-year manage grant.
INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (
  VALUES
    ('fiscal_year.create'),
    ('fiscal_year.edit'),
    ('fiscal_year.close')
) AS granular(id)
WHERE rc.capability_id = 'fiscal_year.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;

-- Monthly-close visibility previously rode on fiscal_year.view; preserve current access explicitly.
INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, 'monthly_close.view'
FROM role_capabilities rc
WHERE rc.capability_id = 'fiscal_year.view'
ON CONFLICT (role_id, capability_id) DO NOTHING;

-- Period creation previously rode on monthly_close.close; preserve current access explicitly.
INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, 'monthly_close.create'
FROM role_capabilities rc
WHERE rc.capability_id = 'monthly_close.close'
ON CONFLICT (role_id, capability_id) DO NOTHING;
