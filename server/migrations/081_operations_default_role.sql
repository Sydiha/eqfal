-- Migration 081 (Phase B3): default "Operations" role for every existing company that has no role with that name.
-- Business staff who are not accountants: sales/purchase invoices (view, create, edit, submit, approve), supporting documents
-- (view, upload, edit), customer/supplier records (create, edit) and read access to obligations. No manual journals, no
-- fiscal-year or period closing, no VAT close/reopen, no access.* administration, no invoice cancel/delete/adjust/recurring.
-- Additive and idempotent: no capability is registered, no membership or existing role is changed or assigned, custom roles named
-- "Operations" are left untouched (role skipped, nothing granted to it). Kept equal to OPERATIONS_CAPABILITIES in
-- default-role-capabilities.ts (contract test). Rollback (manual, Owner-approved): DELETE the "Operations" roles that no membership uses.
WITH ops_caps(capability_id) AS (
  VALUES
    ('company.view'), ('counterparty.create'), ('counterparty.edit'), ('document.edit'), ('document.upload'), ('document.view'),
    ('invoice.approve'), ('invoice.create'), ('invoice.edit'), ('invoice.submit'), ('invoice.view'), ('obligation.view')
),
new_roles AS (
  INSERT INTO roles (company_id, name, is_full_access)
  SELECT c.id, 'Operations', FALSE
  FROM companies c
  WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.company_id = c.id AND r.name = 'Operations')
  RETURNING id
)
INSERT INTO role_capabilities (role_id, capability_id)
SELECT nr.id, oc.capability_id
FROM new_roles nr
JOIN ops_caps oc ON TRUE
JOIN capabilities cap ON cap.id = oc.capability_id
ON CONFLICT DO NOTHING;
