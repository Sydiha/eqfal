-- Migration 003: users table
-- Stores user identity and hashed credentials.
-- password_hash stores bcrypt output only — plaintext is never persisted.
-- email is the unique login identifier (case-insensitive via LOWER index).
-- is_active = false prevents authentication without deleting the record.

CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique, case-insensitive index on email
CREATE UNIQUE INDEX users_email_lower_idx ON users (LOWER(email));
