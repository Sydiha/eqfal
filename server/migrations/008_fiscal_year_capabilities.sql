-- Migration 008: fiscal-year operational capabilities
-- Global capability identifiers are idempotently seeded here so company-scoped
-- roles can grant access without introducing a new permission model.

INSERT INTO capabilities (id)
VALUES
  ('fiscal_year.view'),
  ('fiscal_year.manage')
ON CONFLICT (id) DO NOTHING;
