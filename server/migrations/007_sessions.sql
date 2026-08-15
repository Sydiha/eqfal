-- Migration 007: server-side authentication sessions
-- Stores only a SHA-256 hash of the opaque browser token.
-- active_company_id is nullable so authenticated users with no active memberships
-- can still hold an identity session without tenant access.

CREATE TABLE sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash        TEXT        NOT NULL UNIQUE,
  active_company_id UUID        REFERENCES companies(id) ON DELETE SET NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sessions_user_idx       ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
