-- Migration 017: Phase 4B counterparties and obligations foundation
INSERT INTO capabilities (id) VALUES ('obligation.view'), ('obligation.manage'), ('obligation.settle') ON CONFLICT (id) DO NOTHING;

CREATE TABLE counterparties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  type TEXT NOT NULL CHECK (type IN ('customer','supplier','government','other')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE, created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), UNIQUE (id, company_id)
);
CREATE INDEX counterparties_company_list_idx ON counterparties(company_id,is_active DESC,name);

ALTER TABLE documents ADD COLUMN counterparty_id UUID;
ALTER TABLE documents ADD CONSTRAINT documents_counterparty_company_fk FOREIGN KEY(counterparty_id,company_id) REFERENCES counterparties(id,company_id) ON DELETE RESTRICT;

CREATE TABLE obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('receivable','payable')), counterparty_id UUID NOT NULL, document_id UUID,
  original_amount NUMERIC(18,2) NOT NULL CHECK(original_amount > 0), recognized_on DATE NOT NULL, due_on DATE,
  verification_status TEXT NOT NULL CHECK(verification_status IN ('unconfirmed','confirmed')),
  source_type TEXT NOT NULL CHECK(source_type IN ('document','opening_balance','manual')),
  source_note TEXT CHECK(source_note IS NULL OR char_length(source_note)<=1000), is_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), UNIQUE(id,company_id),
  FOREIGN KEY(counterparty_id,company_id) REFERENCES counterparties(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(document_id,company_id) REFERENCES documents(id,company_id) ON DELETE RESTRICT,
  CHECK((source_type='document' AND document_id IS NOT NULL) OR (source_type IN ('opening_balance','manual') AND document_id IS NULL)),
  CHECK(due_on IS NULL OR due_on>=recognized_on)
);
CREATE INDEX obligations_company_list_idx ON obligations(company_id,recognized_on DESC);
CREATE UNIQUE INDEX obligations_one_document_idx ON obligations(document_id) WHERE source_type='document';

CREATE TABLE obligation_settlements (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 obligation_id UUID NOT NULL, bank_transaction_id UUID NOT NULL, amount NUMERIC(18,2) NOT NULL CHECK(amount>0),
 created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 note TEXT CHECK(note IS NULL OR char_length(note)<=500), UNIQUE(id,company_id), UNIQUE(bank_transaction_id),
 FOREIGN KEY(obligation_id,company_id) REFERENCES obligations(id,company_id) ON DELETE RESTRICT,
 FOREIGN KEY(bank_transaction_id,company_id) REFERENCES bank_transactions(id,company_id) ON DELETE RESTRICT
);
CREATE INDEX obligation_settlements_company_obligation_idx ON obligation_settlements(company_id,obligation_id,created_at DESC);

-- Cross-table exclusivity cannot be expressed as a normal UNIQUE constraint.
-- These triggers serialize on the bank transaction row and ensure that a direct
-- obligation explanation can never coexist with a match/document explanation.
CREATE FUNCTION enforce_obligation_settlement_explanation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM bank_transactions WHERE id=NEW.bank_transaction_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM bank_transaction_matches WHERE bank_transaction_id=NEW.bank_transaction_id)
     OR EXISTS (SELECT 1 FROM document_settlements WHERE bank_transaction_id=NEW.bank_transaction_id) THEN
    RAISE EXCEPTION 'bank transaction already explained' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER obligation_settlement_explanation_guard BEFORE INSERT OR UPDATE ON obligation_settlements
FOR EACH ROW EXECUTE FUNCTION enforce_obligation_settlement_explanation();

CREATE FUNCTION enforce_document_explanation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM bank_transactions WHERE id=NEW.bank_transaction_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM obligation_settlements WHERE bank_transaction_id=NEW.bank_transaction_id) THEN
    RAISE EXCEPTION 'bank transaction already explained by obligation' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_settlement_obligation_guard BEFORE INSERT OR UPDATE ON document_settlements
FOR EACH ROW EXECUTE FUNCTION enforce_document_explanation();
CREATE TRIGGER bank_match_obligation_guard BEFORE INSERT OR UPDATE ON bank_transaction_matches
FOR EACH ROW EXECUTE FUNCTION enforce_document_explanation();
