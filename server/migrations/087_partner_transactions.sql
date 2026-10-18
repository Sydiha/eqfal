-- Migration 087: in-year partner financial transactions (capital contribution, current-account deposit/withdrawal,
-- partner loan received, partner loan repayment).
-- Additive only: three new tables, new capabilities, new guard triggers. No existing table, column, constraint or row is altered or removed.
-- Accounting policy (Owner, 2026-10-18): an ordinary withdrawal is a debit to the partner's INDIVIDUAL current account (never a distribution or a
-- capital reduction); capital, current accounts and partner loans stay separately classified. Distributions and capital reductions are NOT part of this.
-- Accounts are never guessed: a transaction is postable only when the accountant has configured valid mappings (partner_account_mappings per partner,
-- partner_cash_account_mappings per bank account or cash) and a user holding partner.transaction.post posts it explicitly.
-- Posting goes through the canonical journal-posting contract with source_type 'partner_transaction' (one journal per transaction, enforced by the
-- existing journal_entries_source_uidx). A posted transaction is immutable except for its single posted -> reversed transition.
-- Capabilities are registered only. No role_capabilities row is inserted: no default role gains them; Full Access holds them through the wildcard (075).
-- Rollback (only while no partner_transactions row exists): DROP the three tables, DROP FUNCTION partner_transaction_guard() /
-- partner_transaction_bank_exclusivity() / partner_bank_transaction_claim_guard(), DELETE FROM capabilities WHERE id IN (the five below).

INSERT INTO capabilities (id) VALUES
  ('partner.transaction.view'),
  ('partner.transaction.create'),
  ('partner.transaction.post'),
  ('partner.transaction.reverse'),
  ('partner.account_mapping.manage')
ON CONFLICT (id) DO NOTHING;

-- Per-partner mapped accounts. 'capital' -> equity; 'current' -> equity or liability (the accountant's classification of the individual current
-- account is respected, not decided here); 'loan' -> liability. Type and activity are validated on write and re-validated at posting.
CREATE TABLE partner_account_mappings (
  company_id         UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  partner_id         UUID        NOT NULL,
  mapping_key        TEXT        NOT NULL CHECK (mapping_key IN ('capital','current','loan')),
  account_id         UUID        NOT NULL,
  updated_by_user_id UUID        NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, partner_id, mapping_key),
  FOREIGN KEY (partner_id, company_id) REFERENCES partners(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);

-- The company-side (cash or bank) account: one per bank account, plus one for cash (bank_account_id NULL). Asset accounts only.
CREATE TABLE partner_cash_account_mappings (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id    UUID,
  account_id         UUID        NOT NULL,
  updated_by_user_id UUID        NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (bank_account_id, company_id) REFERENCES bank_accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX partner_cash_mapping_bank_uidx ON partner_cash_account_mappings (company_id, bank_account_id) WHERE bank_account_id IS NOT NULL;
CREATE UNIQUE INDEX partner_cash_mapping_cash_uidx ON partner_cash_account_mappings (company_id) WHERE bank_account_id IS NULL;

CREATE TABLE partner_transactions (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  partner_id          UUID          NOT NULL,
  transaction_type    TEXT          NOT NULL CHECK (transaction_type IN ('capital_contribution','current_deposit','current_withdrawal','loan_received','loan_repayment')),
  transaction_date    DATE          NOT NULL,
  amount              NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  channel             TEXT          NOT NULL CHECK (channel IN ('bank','cash')),
  bank_account_id     UUID,
  bank_transaction_id UUID,
  document_id         UUID,
  reference           TEXT          CHECK (reference IS NULL OR char_length(reference) <= 200),
  description         TEXT          CHECK (description IS NULL OR char_length(description) <= 1000),
  status              TEXT          NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','reversed')),
  journal_entry_id    UUID,
  reversal_journal_id UUID,
  posted_by           UUID          REFERENCES users(id),
  posted_at           TIMESTAMPTZ,
  reversed_by         UUID          REFERENCES users(id),
  reversed_at         TIMESTAMPTZ,
  reversal_date       DATE,
  reversal_reason     TEXT          CHECK (reversal_reason IS NULL OR char_length(reversal_reason) BETWEEN 1 AND 500),
  created_by          UUID          NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  version             INTEGER       NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, company_id),
  FOREIGN KEY (partner_id, company_id) REFERENCES partners(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (bank_account_id, company_id) REFERENCES bank_accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (bank_transaction_id, company_id) REFERENCES bank_transactions(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (document_id, company_id) REFERENCES documents(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (reversal_journal_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  -- A bank-channel transaction names its bank account; a cash one has neither a bank account nor a bank statement row.
  CONSTRAINT partner_tx_channel_check CHECK (
    (channel = 'bank' AND bank_account_id IS NOT NULL) OR (channel = 'cash' AND bank_account_id IS NULL AND bank_transaction_id IS NULL)),
  CONSTRAINT partner_tx_state_check CHECK (
    (status = 'draft' AND journal_entry_id IS NULL AND posted_by IS NULL AND posted_at IS NULL AND reversal_journal_id IS NULL
       AND reversed_by IS NULL AND reversed_at IS NULL AND reversal_date IS NULL AND reversal_reason IS NULL)
    OR (status = 'posted' AND journal_entry_id IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL AND reversal_journal_id IS NULL
       AND reversed_by IS NULL AND reversed_at IS NULL AND reversal_date IS NULL AND reversal_reason IS NULL)
    OR (status = 'reversed' AND journal_entry_id IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL AND reversal_journal_id IS NOT NULL
       AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL AND reversal_date IS NOT NULL AND reversal_reason IS NOT NULL
       AND reversal_date >= transaction_date))
);
CREATE INDEX partner_tx_partner_idx ON partner_transactions (company_id, partner_id, transaction_date, created_at);
CREATE INDEX partner_tx_status_idx ON partner_transactions (company_id, status, transaction_date);
CREATE UNIQUE INDEX partner_tx_journal_uidx ON partner_transactions (journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE UNIQUE INDEX partner_tx_reversal_journal_uidx ON partner_transactions (reversal_journal_id) WHERE reversal_journal_id IS NOT NULL;
-- A bank statement row backs at most one live partner transaction; a reversal releases it.
CREATE UNIQUE INDEX partner_tx_bank_transaction_uidx ON partner_transactions (bank_transaction_id) WHERE bank_transaction_id IS NOT NULL AND status IN ('draft','posted');

-- Posted/reversed rows are frozen: the only change allowed is posted -> reversed (reversal fields), draft rows are the only deletable ones.
CREATE FUNCTION partner_transaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'a posted or reversed partner transaction cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'reversed' THEN RAISE EXCEPTION 'a reversed partner transaction is immutable' USING ERRCODE = '55000'; END IF;
  IF OLD.status = 'posted' THEN
    IF NEW.status <> 'reversed'
       OR (NEW.company_id, NEW.partner_id, NEW.transaction_type, NEW.transaction_date, NEW.amount, NEW.channel, NEW.bank_account_id, NEW.bank_transaction_id,
           NEW.document_id, NEW.reference, NEW.description, NEW.journal_entry_id, NEW.posted_by, NEW.posted_at, NEW.created_by, NEW.created_at)
          IS DISTINCT FROM
          (OLD.company_id, OLD.partner_id, OLD.transaction_type, OLD.transaction_date, OLD.amount, OLD.channel, OLD.bank_account_id, OLD.bank_transaction_id,
           OLD.document_id, OLD.reference, OLD.description, OLD.journal_entry_id, OLD.posted_by, OLD.posted_at, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'a posted partner transaction is immutable; reverse it instead' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'reversed' THEN RAISE EXCEPTION 'a draft partner transaction cannot be reversed' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_transaction_guard BEFORE UPDATE OR DELETE ON partner_transactions
FOR EACH ROW EXECUTE FUNCTION partner_transaction_guard();

-- Cross-table exclusivity of a bank statement row (same serialisation as migration 017: lock the bank transaction row, then check).
-- A row already explained by a match, document settlement or obligation settlement cannot back a partner transaction, and the reverse.
CREATE FUNCTION partner_transaction_bank_exclusivity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bank_transaction_id IS NULL OR NEW.status NOT IN ('draft','posted') THEN RETURN NEW; END IF;
  PERFORM 1 FROM bank_transactions WHERE id = NEW.bank_transaction_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM bank_transaction_matches WHERE bank_transaction_id = NEW.bank_transaction_id)
     OR EXISTS (SELECT 1 FROM document_settlements WHERE bank_transaction_id = NEW.bank_transaction_id)
     OR EXISTS (SELECT 1 FROM obligation_settlements WHERE bank_transaction_id = NEW.bank_transaction_id) THEN
    RAISE EXCEPTION 'bank transaction already explained' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_transaction_bank_exclusivity BEFORE INSERT OR UPDATE OF bank_transaction_id, status ON partner_transactions
FOR EACH ROW EXECUTE FUNCTION partner_transaction_bank_exclusivity();

CREATE FUNCTION partner_bank_transaction_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM bank_transactions WHERE id = NEW.bank_transaction_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM partner_transactions WHERE bank_transaction_id = NEW.bank_transaction_id AND status IN ('draft','posted')) THEN
    RAISE EXCEPTION 'bank transaction already explained by a partner transaction' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_tx_claim_guard BEFORE INSERT OR UPDATE ON bank_transaction_matches
FOR EACH ROW EXECUTE FUNCTION partner_bank_transaction_claim_guard();
CREATE TRIGGER partner_tx_claim_guard BEFORE INSERT OR UPDATE ON document_settlements
FOR EACH ROW EXECUTE FUNCTION partner_bank_transaction_claim_guard();
CREATE TRIGGER partner_tx_claim_guard BEFORE INSERT OR UPDATE ON obligation_settlements
FOR EACH ROW EXECUTE FUNCTION partner_bank_transaction_claim_guard();
