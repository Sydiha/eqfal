-- Wave 1 / Task 3: Companies Management capabilities.
-- Data-only: registers the capabilities. Full Access roles receive every registered
-- capability implicitly; no role_capabilities rows are granted here (explicit grants
-- are made by administrators through Users & Permissions, subject to the ceiling rule).

INSERT INTO capabilities (id)
VALUES
  ('company.view'),
  ('company.create'),
  ('company.edit'),
  ('company.status.edit')
ON CONFLICT (id) DO NOTHING;
