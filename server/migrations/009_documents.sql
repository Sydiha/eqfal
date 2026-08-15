-- Migration 009: secure document upload foundation

CREATE TABLE documents (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  uploaded_by_user_id UUID        NOT NULL REFERENCES users(id),
  status              TEXT        NOT NULL DEFAULT 'uploaded'
                                 CHECK (status IN ('uploaded','needs_review','approved','incomplete','rejected')),
  original_filename   TEXT        NOT NULL,
  mime_type           TEXT        NOT NULL,
  size_bytes          INTEGER     NOT NULL CHECK (size_bytes > 0),
  storage_key         TEXT        NOT NULL UNIQUE,
  sha256              TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX documents_company_created_idx
  ON documents (company_id, created_at DESC);

CREATE INDEX documents_company_sha256_idx
  ON documents (company_id, sha256);

INSERT INTO capabilities (id)
VALUES
  ('document.view'),
  ('document.upload')
ON CONFLICT (id) DO NOTHING;
