-- Migration 023: company-scoped Full Access roles

ALTER TABLE roles
  ADD COLUMN is_full_access BOOLEAN NOT NULL DEFAULT FALSE;

-- Promote only the approved test-company role. If it is absent, no row changes.
UPDATE roles
SET is_full_access = TRUE
WHERE id = 'a7360c62-5b19-4333-8184-fb74e7465b43'
  AND company_id = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def';
