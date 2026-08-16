-- Migration 014: Phase 3C payment settlement foundation

INSERT INTO capabilities (id)
VALUES ('payment.settle')
ON CONFLICT (id) DO NOTHING;

-- A settlement represents how much of one approved document is explained by one
-- already-matched bank transaction. Phase 3C intentionally keeps one settlement
-- per bank transaction while allowing several transactions to settle one document.
ALTER TABLE bank_transaction_matches
  ADD CONSTRAINT bank_transaction_matches_tx_company_document_uidx
  UNIQUE (bank_transaction_id, company_id, document_id);

CREATE TABLE document_settlements (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id         UUID          NOT NULL,
  bank_transaction_id UUID          NOT NULL,
  amount              NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  created_by_user_id  UUID          NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  note                TEXT          CHECK (note IS NULL OR char_length(note) <= 500),
  UNIQUE (bank_transaction_id),
  UNIQUE (id, company_id),
  FOREIGN KEY (document_id, company_id)
    REFERENCES documents(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (bank_transaction_id, company_id)
    REFERENCES bank_transactions(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (bank_transaction_id, company_id, document_id)
    REFERENCES bank_transaction_matches(bank_transaction_id, company_id, document_id) ON DELETE RESTRICT
);

CREATE INDEX document_settlements_company_document_idx
  ON document_settlements (company_id, document_id, created_at DESC);
