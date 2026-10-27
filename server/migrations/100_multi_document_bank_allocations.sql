-- Migration 100: one bank transaction may settle several documents (D2 / R9).
--
-- Before: one document match and one document settlement per bank transaction (013/014).
-- After:  a bank transaction may carry several DOCUMENT matches, each with at most one settlement (allocation).
--         Custody relationships stay one per bank transaction and never coexist with document matches.
--         The sum of the allocations of a bank transaction can never exceed its absolute amount.
-- Existing rows are not modified. Every existing bank transaction has at most one match and one settlement, which satisfies
-- every new rule except possibly the allocation cap; the cap is checked only for rows written after this migration.

ALTER TABLE document_settlements DROP CONSTRAINT document_settlements_bank_transaction_id_key;
ALTER TABLE document_settlements
  ADD CONSTRAINT document_settlements_tx_document_uidx UNIQUE (bank_transaction_id, document_id);

ALTER TABLE bank_transaction_matches DROP CONSTRAINT bank_transaction_matches_bank_transaction_id_key;
-- A custody relationship still explains the whole bank transaction.
CREATE UNIQUE INDEX bank_transaction_matches_custody_one_uidx
  ON bank_transaction_matches (bank_transaction_id) WHERE match_type <> 'document';
CREATE INDEX bank_transaction_matches_tx_idx ON bank_transaction_matches (bank_transaction_id);
CREATE INDEX document_settlements_tx_idx ON document_settlements (bank_transaction_id);

-- Document matches and a custody relationship never share a bank transaction (serialized on the bank transaction row).
CREATE FUNCTION enforce_bank_match_kind_exclusivity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM bank_transactions WHERE id=NEW.bank_transaction_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM bank_transaction_matches m
     WHERE m.bank_transaction_id=NEW.bank_transaction_id AND m.id<>NEW.id
       AND (NEW.match_type<>'document' OR m.match_type<>'document')
  ) THEN
    RAISE EXCEPTION 'bank transaction already explained' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_match_kind_exclusivity_guard BEFORE INSERT OR UPDATE OF bank_transaction_id, match_type ON bank_transaction_matches
FOR EACH ROW EXECUTE FUNCTION enforce_bank_match_kind_exclusivity();

-- Backstop for the service rule: allocations of one bank transaction never exceed its absolute amount.
-- Deferred to commit so a multi-allocation request is checked once, as a whole.
CREATE FUNCTION enforce_document_settlement_bank_cap() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE total NUMERIC; bank_amount NUMERIC;
BEGIN
  SELECT ABS(amount) INTO bank_amount FROM bank_transactions WHERE id=NEW.bank_transaction_id;
  SELECT COALESCE(SUM(amount),0) INTO total FROM document_settlements WHERE bank_transaction_id=NEW.bank_transaction_id;
  IF total > bank_amount THEN
    RAISE EXCEPTION 'document settlements exceed the bank transaction amount' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_settlement_bank_cap_guard
AFTER INSERT OR UPDATE OF amount, bank_transaction_id ON document_settlements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_document_settlement_bank_cap();
