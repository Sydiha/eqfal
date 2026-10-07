-- Migration 061: optional company logo stored in PostgreSQL (additive; survives backup/restore and VPS migration).
-- One row per company. ON DELETE CASCADE: companies are never hard-deleted in the product, but if a company
-- row is ever removed its logo goes with it (no orphaned binary data).
CREATE TABLE IF NOT EXISTS company_logos (
  company_id UUID        PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  mime_type  TEXT        NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes INTEGER     NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 524288),
  sha256     TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  data       BYTEA       NOT NULL,
  updated_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
