-- FIN-BANK-OWNERSHIP-01 Phase A: additive, inert ownership staging schema.
--
-- Rows in these tables are non-authoritative. Phase A does not reserve bank
-- transaction capacity, validate journal movements, affect reconciliation, or
-- guard journal posting. A later migration must add those controls before it
-- can introduce any state other than `staged`.

CREATE TABLE bank_transaction_accounting_claims (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  bank_transaction_id UUID          NOT NULL,
  owner_type          TEXT          NOT NULL CHECK (char_length(btrim(owner_type)) BETWEEN 1 AND 100),
  owner_id            UUID          NOT NULL,
  signed_amount       NUMERIC(18,2) NOT NULL CHECK (signed_amount <> 0),
  enforcement_state   TEXT          NOT NULL DEFAULT 'staged' CHECK (enforcement_state = 'staged'),
  created_by          UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, owner_type, owner_id),
  FOREIGN KEY (bank_transaction_id, company_id)
    REFERENCES bank_transactions(id, company_id) ON DELETE RESTRICT
);

CREATE INDEX bank_transaction_accounting_claims_bank_idx
  ON bank_transaction_accounting_claims (company_id, bank_transaction_id, id);
CREATE INDEX bank_transaction_accounting_claims_created_idx
  ON bank_transaction_accounting_claims (company_id, created_at, id);

CREATE TABLE bank_transaction_journal_evidence (
  claim_id               UUID        PRIMARY KEY,
  company_id             UUID        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  journal_entry_id       UUID        NOT NULL,
  bank_ledger_account_id UUID        NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (claim_id, company_id)
    REFERENCES bank_transaction_accounting_claims(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (journal_entry_id, company_id)
    REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (bank_ledger_account_id, company_id)
    REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);

CREATE INDEX bank_transaction_journal_evidence_journal_idx
  ON bank_transaction_journal_evidence (company_id, journal_entry_id, bank_ledger_account_id, claim_id);
CREATE INDEX bank_transaction_journal_evidence_account_idx
  ON bank_transaction_journal_evidence (company_id, bank_ledger_account_id, journal_entry_id, claim_id);

CREATE FUNCTION protect_staged_bank_transaction_accounting_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staged bank transaction accounting ownership is immutable' USING ERRCODE='55000';
END $$;

CREATE TRIGGER bank_transaction_accounting_claims_immutable
  BEFORE UPDATE OR DELETE ON bank_transaction_accounting_claims
  FOR EACH ROW EXECUTE FUNCTION protect_staged_bank_transaction_accounting_ownership();

CREATE TRIGGER bank_transaction_journal_evidence_immutable
  BEFORE UPDATE OR DELETE ON bank_transaction_journal_evidence
  FOR EACH ROW EXECUTE FUNCTION protect_staged_bank_transaction_accounting_ownership();
