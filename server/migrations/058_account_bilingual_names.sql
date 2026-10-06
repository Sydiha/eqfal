-- Task 30B: optional bilingual chart-of-accounts names.
-- Additive and non-destructive: existing rows keep their current `name` unchanged and
-- receive NULL localized names (no translation, no backfill). `name` stays NOT NULL as
-- the backward-compatible fallback used by existing reports, exports and integrations.
ALTER TABLE accounts
  ADD COLUMN name_ar TEXT,
  ADD COLUMN name_en TEXT;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_name_ar_length_check CHECK (name_ar IS NULL OR length(btrim(name_ar)) BETWEEN 1 AND 200),
  ADD CONSTRAINT accounts_name_en_length_check CHECK (name_en IS NULL OR length(btrim(name_en)) BETWEEN 1 AND 200);
