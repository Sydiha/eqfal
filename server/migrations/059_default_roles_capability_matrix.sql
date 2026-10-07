-- Migration 059: Default role capability matrix (Viewer, Accountant, Finance Manager)
--
-- Implements the final approved default role capability matrix:
-- - Viewer: 20 capabilities (read-only view across all domains)
-- - Accountant: 46 capabilities (Viewer + 26 operational)
-- - Finance Manager: 96 capabilities (Accountant + 50 FM-only)
-- - Legacy/unassigned: 13 capabilities (do NOT grant to default roles)
--
-- This migration is idempotent: safe to run multiple times with same result.
-- It corrects roles IN PLACE by deleting old capabilities and inserting approved ones.

-- Ensure all required capabilities exist in the database
INSERT INTO capabilities (id) VALUES
  -- Viewer (20)
  ('accounting.view'),
  ('annual_close.view'),
  ('annual_close.package.view'),
  ('asset.view'),
  ('audit.view'),
  ('bank.view'),
  ('company.view'),
  ('company_accounting_profile.view'),
  ('custody.view'),
  ('document.view'),
  ('fiscal_year.view'),
  ('monthly_close.view'),
  ('obligation.view'),
  ('opening_balance.view'),
  ('partner.view'),
  ('periodic_adjustment.view'),
  ('report.view'),
  ('tax_workpaper.view'),
  ('vat.view'),
  ('wht_review.view'),
  -- Accountant additional (26)
  ('accounting.journal.create'),
  ('accounting.journal.edit'),
  ('accounting.journal.post'),
  ('asset.create'),
  ('asset.edit'),
  ('bank.import'),
  ('bank.match'),
  ('bank.reconcile'),
  ('counterparty.create'),
  ('counterparty.edit'),
  ('document.edit'),
  ('document.upload'),
  ('obligation.create'),
  ('obligation.edit'),
  ('obligation.confirm'),
  ('obligation.settlement.create'),
  ('opening_balance.item.create'),
  ('opening_balance.item.edit'),
  ('opening_balance.item.delete'),
  ('partner.create'),
  ('partner.edit'),
  ('periodic_adjustment.create'),
  ('periodic_adjustment.edit'),
  ('periodic_adjustment.post'),
  ('periodic_adjustment.submit'),
  ('vat.review'),
  -- Finance Manager additional (50)
  ('accounting.chart.create'),
  ('accounting.chart.edit'),
  ('asset.approve'),
  ('asset.cancel'),
  ('asset.dispose'),
  ('asset.estimate_change.approve'),
  ('asset.estimate_change.create'),
  ('asset.estimate_change.review'),
  ('company_accounting_profile.approve'),
  ('company_accounting_profile.create'),
  ('company_accounting_profile.edit'),
  ('company_accounting_profile.review'),
  ('company_accounting_profile.submit'),
  ('counterparty.disable'),
  ('custody.close'),
  ('custody.manage'),
  ('document.approve'),
  ('document.review'),
  ('document.submit'),
  ('fiscal_year.close'),
  ('fiscal_year.create'),
  ('fiscal_year.edit'),
  ('monthly_close.close'),
  ('monthly_close.create'),
  ('annual_close.package.approve'),
  ('annual_close.package.create'),
  ('annual_close.package.handoff'),
  ('annual_close.package.review'),
  ('annual_close.package.snapshot.create'),
  ('obligation.cancel'),
  ('obligation.settlement.remove'),
  ('opening_balance.approve'),
  ('opening_balance.review'),
  ('opening_balance.submit'),
  ('partner.disable'),
  ('periodic_adjustment.approve'),
  ('periodic_adjustment.review'),
  ('tax_workpaper.adjust.create'),
  ('tax_workpaper.adjust.delete'),
  ('tax_workpaper.adjust.edit'),
  ('tax_workpaper.approve'),
  ('tax_workpaper.create'),
  ('tax_workpaper.edit'),
  ('tax_workpaper.review'),
  ('tax_workpaper.submit'),
  ('vat.close'),
  ('wht_review.create'),
  ('wht_review.edit'),
  ('wht_review.review'),
  ('wht_review.submit'),
  -- Legacy/unassigned (13) - ensure they exist but do NOT grant to default roles
  ('accounting.chart.manage'),
  ('accounting.journal.manage'),
  ('annual_close.package.manage'),
  ('asset.manage'),
  ('bank.account.manage'),
  ('company_accounting_profile.manage'),
  ('fiscal_year.manage'),
  ('obligation.manage'),
  ('opening_balance.manage'),
  ('partner.manage'),
  ('periodic_adjustment.manage'),
  ('tax_workpaper.manage'),
  ('obligation.settle')
ON CONFLICT (id) DO NOTHING;

-- Create or ensure default roles exist for test company (0e8574b6-5828-40c6-9b56-7dbd1c7e9def)
-- Idempotently create roles by checking if they already exist
INSERT INTO roles (company_id, name, is_full_access)
SELECT
  '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid,
  name,
  FALSE
FROM (VALUES
  ('viewer'),
  ('accountant'),
  ('finance_manager')
) AS new_roles(name)
WHERE NOT EXISTS (
  SELECT 1 FROM roles r
  WHERE r.company_id = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid
  AND r.name = new_roles.name
  AND r.is_full_access = FALSE
);

-- Correct Viewer role (20 capabilities)
-- First, remove all non-full-access role_capabilities for the viewer role
DELETE FROM role_capabilities
WHERE role_id IN (
  SELECT id FROM roles
  WHERE company_id = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid
  AND name = 'viewer'
  AND is_full_access = FALSE
);

-- Insert exactly 20 viewer capabilities
INSERT INTO role_capabilities (role_id, capability_id)
SELECT
  r.id,
  cap.id
FROM roles r
CROSS JOIN (VALUES
  ('accounting.view'),
  ('annual_close.view'),
  ('annual_close.package.view'),
  ('asset.view'),
  ('audit.view'),
  ('bank.view'),
  ('company.view'),
  ('company_accounting_profile.view'),
  ('custody.view'),
  ('document.view'),
  ('fiscal_year.view'),
  ('monthly_close.view'),
  ('obligation.view'),
  ('opening_balance.view'),
  ('partner.view'),
  ('periodic_adjustment.view'),
  ('report.view'),
  ('tax_workpaper.view'),
  ('vat.view'),
  ('wht_review.view')
) AS cap(id)
WHERE r.company_id = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid
AND r.name = 'viewer'
AND r.is_full_access = FALSE
ON CONFLICT (role_id, capability_id) DO NOTHING;

-- Correct Accountant role (46 capabilities = 20 Viewer + 26 additional)
-- First, remove all non-full-access role_capabilities for the accountant role
DELETE FROM role_capabilities
WHERE role_id IN (
  SELECT id FROM roles
  WHERE company_id = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid
  AND name = 'accountant'
  AND is_full_access = FALSE
);

-- Insert all 46 accountant capabilities
INSERT INTO role_capabilities (role_id, capability_id)
SELECT
  r.id,
  cap.id
FROM roles r
CROSS JOIN (VALUES
  -- Viewer (20)
  ('accounting.view'),
  ('annual_close.view'),
  ('annual_close.package.view'),
  ('asset.view'),
  ('audit.view'),
  ('bank.view'),
  ('company.view'),
  ('company_accounting_profile.view'),
  ('custody.view'),
  ('document.view'),
  ('fiscal_year.view'),
  ('monthly_close.view'),
  ('obligation.view'),
  ('opening_balance.view'),
  ('partner.view'),
  ('periodic_adjustment.view'),
  ('report.view'),
  ('tax_workpaper.view'),
  ('vat.view'),
  ('wht_review.view'),
  -- Accountant additional (26)
  ('accounting.journal.create'),
  ('accounting.journal.edit'),
  ('accounting.journal.post'),
  ('asset.create'),
  ('asset.edit'),
  ('bank.import'),
  ('bank.match'),
  ('bank.reconcile'),
  ('counterparty.create'),
  ('counterparty.edit'),
  ('document.edit'),
  ('document.upload'),
  ('obligation.create'),
  ('obligation.edit'),
  ('obligation.confirm'),
  ('obligation.settlement.create'),
  ('opening_balance.item.create'),
  ('opening_balance.item.edit'),
  ('opening_balance.item.delete'),
  ('partner.create'),
  ('partner.edit'),
  ('periodic_adjustment.create'),
  ('periodic_adjustment.edit'),
  ('periodic_adjustment.post'),
  ('periodic_adjustment.submit'),
  ('vat.review')
) AS cap(id)
WHERE r.company_id = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid
AND r.name = 'accountant'
AND r.is_full_access = FALSE
ON CONFLICT (role_id, capability_id) DO NOTHING;

-- Create or ensure Finance Manager role exists, then correct it (96 capabilities)
-- First ensure the role exists
INSERT INTO roles (company_id, name, is_full_access)
VALUES ('0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid, 'finance_manager', FALSE)
ON CONFLICT (company_id, name) DO NOTHING;

-- Remove all non-full-access role_capabilities for the finance_manager role
DELETE FROM role_capabilities
WHERE role_id IN (
  SELECT id FROM roles
  WHERE company_id = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid
  AND name = 'finance_manager'
  AND is_full_access = FALSE
);

-- Insert all 96 finance manager capabilities
INSERT INTO role_capabilities (role_id, capability_id)
SELECT
  r.id,
  cap.id
FROM roles r
CROSS JOIN (VALUES
  -- Viewer (20)
  ('accounting.view'),
  ('annual_close.view'),
  ('annual_close.package.view'),
  ('asset.view'),
  ('audit.view'),
  ('bank.view'),
  ('company.view'),
  ('company_accounting_profile.view'),
  ('custody.view'),
  ('document.view'),
  ('fiscal_year.view'),
  ('monthly_close.view'),
  ('obligation.view'),
  ('opening_balance.view'),
  ('partner.view'),
  ('periodic_adjustment.view'),
  ('report.view'),
  ('tax_workpaper.view'),
  ('vat.view'),
  ('wht_review.view'),
  -- Accountant additional (26)
  ('accounting.journal.create'),
  ('accounting.journal.edit'),
  ('accounting.journal.post'),
  ('asset.create'),
  ('asset.edit'),
  ('bank.import'),
  ('bank.match'),
  ('bank.reconcile'),
  ('counterparty.create'),
  ('counterparty.edit'),
  ('document.edit'),
  ('document.upload'),
  ('obligation.create'),
  ('obligation.edit'),
  ('obligation.confirm'),
  ('obligation.settlement.create'),
  ('opening_balance.item.create'),
  ('opening_balance.item.edit'),
  ('opening_balance.item.delete'),
  ('partner.create'),
  ('partner.edit'),
  ('periodic_adjustment.create'),
  ('periodic_adjustment.edit'),
  ('periodic_adjustment.post'),
  ('periodic_adjustment.submit'),
  ('vat.review'),
  -- Finance Manager additional (50)
  ('accounting.chart.create'),
  ('accounting.chart.edit'),
  ('asset.approve'),
  ('asset.cancel'),
  ('asset.dispose'),
  ('asset.estimate_change.approve'),
  ('asset.estimate_change.create'),
  ('asset.estimate_change.review'),
  ('company_accounting_profile.approve'),
  ('company_accounting_profile.create'),
  ('company_accounting_profile.edit'),
  ('company_accounting_profile.review'),
  ('company_accounting_profile.submit'),
  ('counterparty.disable'),
  ('custody.close'),
  ('custody.manage'),
  ('document.approve'),
  ('document.review'),
  ('document.submit'),
  ('fiscal_year.close'),
  ('fiscal_year.create'),
  ('fiscal_year.edit'),
  ('monthly_close.close'),
  ('monthly_close.create'),
  ('annual_close.package.approve'),
  ('annual_close.package.create'),
  ('annual_close.package.handoff'),
  ('annual_close.package.review'),
  ('annual_close.package.snapshot.create'),
  ('obligation.cancel'),
  ('obligation.settlement.remove'),
  ('opening_balance.approve'),
  ('opening_balance.review'),
  ('opening_balance.submit'),
  ('partner.disable'),
  ('periodic_adjustment.approve'),
  ('periodic_adjustment.review'),
  ('tax_workpaper.adjust.create'),
  ('tax_workpaper.adjust.delete'),
  ('tax_workpaper.adjust.edit'),
  ('tax_workpaper.approve'),
  ('tax_workpaper.create'),
  ('tax_workpaper.edit'),
  ('tax_workpaper.review'),
  ('tax_workpaper.submit'),
  ('vat.close'),
  ('wht_review.create'),
  ('wht_review.edit'),
  ('wht_review.review'),
  ('wht_review.submit')
) AS cap(id)
WHERE r.company_id = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid
AND r.name = 'finance_manager'
AND r.is_full_access = FALSE
ON CONFLICT (role_id, capability_id) DO NOTHING;

-- Verify Full Access role is unchanged
-- The admin/full-access role (is_full_access = TRUE) should NOT have explicit
-- role_capabilities entries; its access is implicit based on is_full_access = TRUE.
-- This migration makes no changes to Full Access roles.
