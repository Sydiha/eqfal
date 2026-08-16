-- Migration 013: Phase 3B bank transaction matching / reconciliation foundation

INSERT INTO capabilities (id)
VALUES ('bank.match'), ('bank.reconcile')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE bank_transactions
  ADD COLUMN reconciliation_status TEXT NOT NULL DEFAULT 'unmatched'
    CHECK (reconciliation_status IN ('unmatched','matched','reconciled')),
  ADD COLUMN reconciled_by_user_id UUID REFERENCES users(id),
  ADD COLUMN reconciled_at TIMESTAMPTZ,
  ADD CONSTRAINT bank_transactions_company_identity_unique UNIQUE (id, company_id);

ALTER TABLE bank_transactions
  ADD CONSTRAINT bank_transactions_reconciliation_metadata_check
  CHECK (
    (reconciliation_status = 'reconciled' AND reconciled_by_user_id IS NOT NULL AND reconciled_at IS NOT NULL)
    OR
    (reconciliation_status <> 'reconciled' AND reconciled_by_user_id IS NULL AND reconciled_at IS NULL)
  );

CREATE TABLE bank_transaction_matches (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_transaction_id UUID        NOT NULL,
  document_id         UUID        NOT NULL,
  matched_by_user_id  UUID        NOT NULL REFERENCES users(id),
  matched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note                TEXT        CHECK (note IS NULL OR char_length(note) <= 500),
  UNIQUE (bank_transaction_id),
  UNIQUE (id, company_id),
  FOREIGN KEY (bank_transaction_id, company_id)
    REFERENCES bank_transactions(id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, company_id)
    REFERENCES documents(id, company_id)
);

CREATE INDEX bank_transaction_matches_company_idx
  ON bank_transaction_matches (company_id, matched_at DESC);
CREATE INDEX bank_transaction_matches_document_idx
  ON bank_transaction_matches (company_id, document_id);
