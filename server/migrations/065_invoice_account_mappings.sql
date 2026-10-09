-- Migration 065: invoice account mappings (A1) and invoice-backed obligations (A2). Structure only, no data rows.
-- Inserts NO rows: no company has any mapping until an authorized person sets one, and nothing reads this table to
-- post anything. Owner decision A1 (2026-10-09): mappings are per company, validated by account type, and approval
-- journal preparation is rejected when a required mapping is missing or inactive. Accounts are never guessed.
-- Rollback: DROP TABLE invoice_account_mappings;

CREATE TABLE invoice_account_mappings (
  company_id         UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mapping_key        TEXT        NOT NULL CHECK (mapping_key IN ('receivable','payable','sales_revenue','purchase_expense','vat_output','vat_input')),
  account_id         UUID        NOT NULL,
  updated_by_user_id UUID        NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, mapping_key),
  -- composite FK: the mapped account must belong to the same company
  CONSTRAINT invoice_account_mappings_account_fk FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);

-- Invoice-backed obligations (owner decision A2, 2026-10-09): final approval creates exactly one confirmed obligation
-- per invoice, in the approval transaction. Existing rows are untouched (they keep invoice_id NULL).
-- Rollback: drop the index/column and restore obligations_source_type_check / obligations_check to their 017 form.
ALTER TABLE obligations ADD COLUMN invoice_id UUID;
ALTER TABLE obligations ADD CONSTRAINT obligations_invoice_company_fk FOREIGN KEY (invoice_id, company_id) REFERENCES invoices(id, company_id) ON DELETE RESTRICT;
ALTER TABLE obligations DROP CONSTRAINT obligations_source_type_check;
ALTER TABLE obligations ADD CONSTRAINT obligations_source_type_check CHECK (source_type IN ('document','opening_balance','manual','invoice'));
ALTER TABLE obligations DROP CONSTRAINT obligations_check;
ALTER TABLE obligations ADD CONSTRAINT obligations_source_link_check CHECK (
  (source_type = 'document' AND document_id IS NOT NULL AND invoice_id IS NULL)
  OR (source_type = 'invoice' AND invoice_id IS NOT NULL AND document_id IS NULL)
  OR (source_type IN ('opening_balance','manual') AND document_id IS NULL AND invoice_id IS NULL));
CREATE UNIQUE INDEX obligations_one_invoice_idx ON obligations (invoice_id) WHERE source_type = 'invoice';

-- An invoice-backed obligation mirrors its approved invoice: amount, date, parties, confirmation and the link are
-- frozen, and it cannot be deleted or cancelled directly (cancellation follows the future invoice-cancellation
-- workflow). Only due_on / source_note may change. A non-invoice obligation cannot be converted into one.
CREATE FUNCTION guard_invoice_obligation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.source_type = 'invoice' AND EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'invoice-backed obligations cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (OLD.source_type = 'invoice' OR NEW.source_type = 'invoice') AND (
       NEW.source_type IS DISTINCT FROM OLD.source_type OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
       OR NEW.original_amount <> OLD.original_amount OR NEW.recognized_on <> OLD.recognized_on
       OR NEW.verification_status <> OLD.verification_status OR NEW.is_cancelled <> OLD.is_cancelled
       OR NEW.counterparty_id <> OLD.counterparty_id OR NEW.direction <> OLD.direction) THEN
    RAISE EXCEPTION 'invoice-backed obligation fields are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_obligation_guard BEFORE UPDATE OR DELETE ON obligations FOR EACH ROW EXECUTE FUNCTION guard_invoice_obligation();
