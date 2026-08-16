-- Migration 012: Phase 3A bank import foundation

INSERT INTO capabilities (id)
VALUES ('bank.view'), ('bank.import'), ('bank.account.manage')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE bank_accounts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  display_name  TEXT        NOT NULL,
  bank_name     TEXT,
  currency_code CHAR(3)     NOT NULL,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by    UUID        NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id)
);
CREATE INDEX bank_accounts_company_idx ON bank_accounts (company_id);

CREATE TABLE bank_import_batches (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id   UUID        NOT NULL,
  original_filename TEXT        NOT NULL,
  mime_type         TEXT        NOT NULL,
  source_format     TEXT        NOT NULL CHECK (source_format IN ('csv', 'xlsx')),
  storage_key       TEXT        NOT NULL,
  file_sha256       TEXT        NOT NULL,
  status            TEXT        NOT NULL CHECK (status IN ('mapping_required', 'preview_ready', 'confirmed')),
  column_mapping    JSONB,
  total_rows        INTEGER     NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  valid_rows        INTEGER     NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
  duplicate_rows    INTEGER     NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0),
  invalid_rows      INTEGER     NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
  created_by        UUID        NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_by      UUID        REFERENCES users(id),
  confirmed_at      TIMESTAMPTZ,
  UNIQUE (company_id, file_sha256),
  UNIQUE (id, company_id),
  FOREIGN KEY (bank_account_id, company_id)
    REFERENCES bank_accounts(id, company_id)
);
CREATE INDEX bank_import_batches_company_idx ON bank_import_batches (company_id, created_at DESC);
CREATE INDEX bank_import_batches_account_idx ON bank_import_batches (bank_account_id);

CREATE TABLE bank_transactions (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id      UUID          NOT NULL,
  import_batch_id      UUID          NOT NULL,
  transaction_date     DATE          NOT NULL,
  value_date           DATE,
  amount               NUMERIC(18,2) NOT NULL,
  currency_code        CHAR(3)       NOT NULL,
  description          TEXT,
  bank_reference       TEXT,
  running_balance      NUMERIC(18,2),
  source_row_number    INTEGER       NOT NULL CHECK (source_row_number > 0),
  fingerprint          TEXT          NOT NULL,
  fingerprint_strength TEXT          NOT NULL CHECK (fingerprint_strength IN ('strong', 'weak')),
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (import_batch_id, source_row_number),
  FOREIGN KEY (bank_account_id, company_id)
    REFERENCES bank_accounts(id, company_id),
  FOREIGN KEY (import_batch_id, company_id)
    REFERENCES bank_import_batches(id, company_id)
);
CREATE INDEX bank_transactions_company_idx ON bank_transactions (company_id, transaction_date DESC);
CREATE INDEX bank_transactions_account_idx ON bank_transactions (bank_account_id, transaction_date DESC);
CREATE INDEX bank_transactions_fingerprint_idx ON bank_transactions (company_id, bank_account_id, fingerprint);
CREATE UNIQUE INDEX bank_transactions_strong_fingerprint_uidx
  ON bank_transactions (company_id, bank_account_id, fingerprint)
  WHERE fingerprint_strength = 'strong';
