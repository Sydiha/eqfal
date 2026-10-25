-- Migration 094: capabilities for the invoice account mapping management page.
-- Registers invoice.mapping.view and invoice.mapping.manage ONLY. No role_capabilities row is inserted: no predefined role
-- receives them; Full Access holds them through the wildcard (075). No data row of invoice_account_mappings is touched.
-- Rollback: DELETE FROM capabilities WHERE id IN ('invoice.mapping.view','invoice.mapping.manage');
INSERT INTO capabilities (id) VALUES ('invoice.mapping.view'), ('invoice.mapping.manage') ON CONFLICT (id) DO NOTHING;
