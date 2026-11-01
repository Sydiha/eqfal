-- Migration 106: manually entered bank transactions (additive).
-- A manual bank transaction is an internal record entered by a user. It is NOT a bank-verified statement row:
-- it has no import batch, source_kind='manual', and it posts no journal. It follows the existing matching/settlement paths.
-- Capability is registered only; no role_capabilities row is inserted (Full Access holds it through the wildcard, as in 088).
-- Paired transfers between two company accounts (inter_account_transfer) are intentionally NOT allowed yet.
-- Rollback (only while no manual rows exist):
--   DELETE FROM bank_transactions WHERE source_kind='manual';   -- only if nothing references them
--   DROP TRIGGER ...; DROP FUNCTION ...; then drop the added columns/constraints and restore NOT NULL on the two columns.

INSERT INTO capabilities (id) VALUES ('bank.transaction.manual') ON CONFLICT (id) DO NOTHING;

ALTER TABLE bank_transactions
  ADD COLUMN source_kind            TEXT NOT NULL DEFAULT 'import',
  ADD COLUMN manual_category        TEXT,
  ADD COLUMN manual_counterparty    TEXT,
  ADD COLUMN supporting_document_id UUID,
  ADD COLUMN created_by_user_id     UUID REFERENCES users(id),
  ALTER COLUMN import_batch_id DROP NOT NULL,
  ALTER COLUMN source_row_number DROP NOT NULL;

ALTER TABLE bank_transactions
  ADD CONSTRAINT bank_transactions_supporting_document_fk
    FOREIGN KEY (supporting_document_id, company_id) REFERENCES documents(id, company_id) ON DELETE RESTRICT,
  ADD CONSTRAINT bank_transactions_source_kind_check CHECK (source_kind IN ('import', 'manual')),
  ADD CONSTRAINT bank_transactions_manual_counterparty_len CHECK (manual_counterparty IS NULL OR char_length(manual_counterparty) <= 200),
  -- Imported rows keep their exact shape; manual rows have no batch/row number and always carry a category and a creator.
  ADD CONSTRAINT bank_transactions_source_shape_check CHECK (
    (source_kind = 'import' AND import_batch_id IS NOT NULL AND source_row_number IS NOT NULL
       AND manual_category IS NULL AND manual_counterparty IS NULL AND supporting_document_id IS NULL)
    OR
    (source_kind = 'manual' AND import_batch_id IS NULL AND source_row_number IS NULL
       AND manual_category IS NOT NULL AND created_by_user_id IS NOT NULL AND running_balance IS NULL)
  ),
  -- Only categories that an existing settlement workflow can resolve are allowed, with a matching direction:
  -- customer_receipt (in), supplier_payment / government_payment (out), other (either; resolved by partner/custody/personal-payment/obligation paths).
  -- Cash movements, transfers, bank fees, refunds and inter_account_transfer are deliberately NOT allowed until a supported workflow exists.
  ADD CONSTRAINT bank_transactions_manual_category_check CHECK (
    source_kind = 'import' OR (
      amount <> 0 AND (
        (manual_category = 'customer_receipt' AND amount > 0)
        OR (manual_category IN ('supplier_payment', 'government_payment') AND amount < 0)
        OR manual_category = 'other'
      )
    )
  );

CREATE INDEX bank_transactions_source_kind_idx ON bank_transactions (company_id, source_kind) WHERE source_kind = 'manual';

-- A manual record is immutable in its identity and amount once entered (corrections are a separate, future workflow).
CREATE FUNCTION bank_manual_transaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.source_kind = 'manual' THEN
      RAISE EXCEPTION 'Manual bank transactions cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.source_kind IS DISTINCT FROM OLD.source_kind THEN
    RAISE EXCEPTION 'Bank transaction source cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.source_kind = 'manual' AND (
       NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
    OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.manual_category IS DISTINCT FROM OLD.manual_category OR NEW.manual_counterparty IS DISTINCT FROM OLD.manual_counterparty
    OR NEW.supporting_document_id IS DISTINCT FROM OLD.supporting_document_id OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.description IS DISTINCT FROM OLD.description OR NEW.bank_reference IS DISTINCT FROM OLD.bank_reference
    OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint) THEN
    RAISE EXCEPTION 'Manual bank transaction fields are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_manual_transaction_guard BEFORE UPDATE OR DELETE ON bank_transactions
FOR EACH ROW EXECUTE FUNCTION bank_manual_transaction_guard();

-- Transfers, cash movements and bank fees must never become revenue/expense through document or obligation settlement.
CREATE FUNCTION bank_manual_internal_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'bank_transaction_matches' THEN
    IF NEW.match_type <> 'document' THEN RETURN NEW; END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM bank_transactions t
     WHERE t.id = NEW.bank_transaction_id AND t.company_id = NEW.company_id AND t.source_kind = 'manual'
       AND t.manual_category IN ('cash_deposit', 'cash_withdrawal', 'incoming_transfer', 'outgoing_transfer', 'bank_fees')
  ) THEN
    RAISE EXCEPTION 'This manual bank transaction category cannot settle documents or obligations' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_manual_internal_guard BEFORE INSERT ON bank_transaction_matches
FOR EACH ROW EXECUTE FUNCTION bank_manual_internal_settlement_guard();
CREATE TRIGGER bank_manual_internal_guard BEFORE INSERT ON document_settlements
FOR EACH ROW EXECUTE FUNCTION bank_manual_internal_settlement_guard();
CREATE TRIGGER bank_manual_internal_guard BEFORE INSERT ON obligation_settlements
FOR EACH ROW EXECUTE FUNCTION bank_manual_internal_settlement_guard();
