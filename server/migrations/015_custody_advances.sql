-- Migration 015: Phase 3D custody / advances foundation

INSERT INTO capabilities (id)
VALUES ('custody.view'), ('custody.manage'), ('custody.close')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE custody_advances (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  holder_user_id      UUID        NOT NULL REFERENCES users(id),
  purpose             TEXT        CHECK (purpose IS NULL OR char_length(purpose) <= 500),
  status              TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by_user_id  UUID        NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by_user_id   UUID        REFERENCES users(id),
  closed_at           TIMESTAMPTZ,
  UNIQUE (id, company_id),
  FOREIGN KEY (holder_user_id, company_id)
    REFERENCES memberships(user_id, company_id) ON DELETE RESTRICT,
  CHECK (
    (status='open' AND closed_by_user_id IS NULL AND closed_at IS NULL)
    OR
    (status='closed' AND closed_by_user_id IS NOT NULL AND closed_at IS NOT NULL)
  )
);
CREATE INDEX custody_advances_company_idx ON custody_advances (company_id, created_at DESC);
CREATE INDEX custody_advances_holder_idx ON custody_advances (company_id, holder_user_id, created_at DESC);

-- Extend the existing bank match table into a single bank-explanation boundary.
-- One bank transaction still has exactly one match because the existing
-- UNIQUE(bank_transaction_id) remains in force.
ALTER TABLE bank_transaction_matches
  ADD COLUMN match_type TEXT NOT NULL DEFAULT 'document',
  ADD COLUMN custody_id UUID,
  ALTER COLUMN document_id DROP NOT NULL;

ALTER TABLE bank_transaction_matches
  ADD CONSTRAINT bank_transaction_matches_type_check
  CHECK (
    (match_type='document' AND document_id IS NOT NULL AND custody_id IS NULL)
    OR
    (match_type IN ('custody_funding','custody_return') AND document_id IS NULL AND custody_id IS NOT NULL)
  ),
  ADD CONSTRAINT bank_transaction_matches_custody_company_fk
  FOREIGN KEY (custody_id, company_id)
    REFERENCES custody_advances(id, company_id) ON DELETE RESTRICT;

CREATE INDEX bank_transaction_matches_custody_idx
  ON bank_transaction_matches (company_id, custody_id, match_type, matched_at DESC)
  WHERE custody_id IS NOT NULL;

CREATE TABLE custody_document_allocations (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  custody_id          UUID          NOT NULL,
  document_id         UUID          NOT NULL,
  amount              NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  created_by_user_id  UUID          NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  note                TEXT          CHECK (note IS NULL OR char_length(note) <= 500),
  UNIQUE (document_id),
  UNIQUE (id, company_id),
  FOREIGN KEY (custody_id, company_id)
    REFERENCES custody_advances(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (document_id, company_id)
    REFERENCES documents(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX custody_document_allocations_custody_idx
  ON custody_document_allocations (company_id, custody_id, created_at DESC);
