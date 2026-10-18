-- Migration 089 (T3 / G1 + G2): personal expense payments made by a manager, employee or partner on behalf of the company, and their reimbursement.
-- Additive: four new tables, seven capabilities, guard triggers, and three CREATE OR REPLACE changes (listed below). No existing row is altered or removed.
-- Accounting policy (Owner, 2026-10-18):
--   * non-partner manager/employee : the payment creates an amount payable to the individual (Cr the payer's mapped liability account);
--   * manager/employee who is also a partner : the payment is recognized through that partner's INDIVIDUAL current account (the existing 'current'
--     mapping of 087), never through a parallel employee payable (a payer is either partner-linked or has a payable account, never both);
--   * a company advance to an individual stays a custody transaction and is not part of this workflow.
-- Two treatments, both posted through the canonical journal-posting contract (source types 'personal_payment' and 'personal_payment_reimbursement'):
--   new_expense         : the expense is not yet recognized. Dr the accountant-chosen expense account / Cr the payer account. Needs an approved expense
--                         document with a known total, equal to the payment; a document claimed by an obligation, custody allocation, bank settlement,
--                         invoice or another live personal payment is refused (trigger below, both directions). Documents carrying reviewed VAT are refused
--                         by the service: VAT must be recognized through the invoice/obligation path (no new tax policy here).
--   existing_obligation : the payable is already recognized. Dr the liability account the obligation was originally credited to / Cr the payer account.
--                         The outstanding amount of the obligation is reduced through obligation_adjustment_net() (replaced below), so every existing
--                         outstanding calculation sees the reclassification and the expense/VAT is never recognized twice.
-- Reimbursement: one company bank transaction (outflow, exact amount) per reimbursement, Dr the payer account / Cr the bank ledger account of the T2
-- bank_account_ledger_links. No expense line, no new bank movement. The sum of reimbursements can never exceed the payment (trigger).
-- Approved payments and all reimbursements are immutable. Capabilities are registered only: no role_capabilities row, Full Access holds them through the wildcard (075).
-- CREATE OR REPLACE changes: obligation_adjustment_net() (072), partner_transaction_bank_exclusivity() and partner_bank_transaction_claim_guard() (087).
-- Rollback (only while personal_payments is empty): restore the 072/087 function bodies, DROP the triggers and functions named personal_payment_*, DROP TABLE
-- personal_payment_events, personal_payment_reimbursements, personal_payments, personal_payers; DELETE FROM capabilities WHERE id LIKE 'personal_payment.%'.

INSERT INTO capabilities (id) VALUES
  ('personal_payment.view'),
  ('personal_payment.create'),
  ('personal_payment.submit'),
  ('personal_payment.review'),
  ('personal_payment.reimburse'),
  ('personal_payment.audit.view'),
  ('personal_payment.payer.manage')
ON CONFLICT (id) DO NOTHING;

-- The explicit, company-scoped payer identity. partner_id is the verifiable association with a partner entity (never inferred from a role or name);
-- payable_account_id is the approved employee/manager payable mapping. user_id optionally ties the payer to a company member.
CREATE TABLE personal_payers (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  display_name       TEXT        NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
  user_id            UUID        REFERENCES users(id),
  partner_id         UUID,
  payable_account_id UUID,
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by         UUID        NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version            INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, company_id),
  FOREIGN KEY (partner_id, company_id) REFERENCES partners(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (payable_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  -- A partner payer never has a parallel employee payable.
  CONSTRAINT personal_payers_one_account_path CHECK (partner_id IS NULL OR payable_account_id IS NULL)
);
CREATE UNIQUE INDEX personal_payers_partner_uidx ON personal_payers (company_id, partner_id) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX personal_payers_user_uidx ON personal_payers (company_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE personal_payments (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payer_id           UUID          NOT NULL,
  treatment          TEXT          NOT NULL CHECK (treatment IN ('new_expense','existing_obligation')),
  payment_date       DATE          NOT NULL,
  accounting_date    DATE          NOT NULL,
  amount             NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency_code      CHAR(3)       NOT NULL,
  purpose            TEXT          NOT NULL CHECK (char_length(btrim(purpose)) BETWEEN 1 AND 500),
  counterparty_id    UUID,
  document_id        UUID,
  obligation_id      UUID,
  expense_account_id UUID,
  status             TEXT          NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  debit_account_id   UUID,
  credit_account_id  UUID,
  journal_entry_id   UUID,
  submitted_by       UUID          REFERENCES users(id),
  submitted_at       TIMESTAMPTZ,
  reviewed_by        UUID          REFERENCES users(id),
  reviewed_at        TIMESTAMPTZ,
  rejection_reason   TEXT          CHECK (rejection_reason IS NULL OR char_length(btrim(rejection_reason)) BETWEEN 1 AND 500),
  created_by         UUID          NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  version            INTEGER       NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, company_id),
  FOREIGN KEY (payer_id, company_id) REFERENCES personal_payers(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (counterparty_id, company_id) REFERENCES counterparties(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (document_id, company_id) REFERENCES documents(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (obligation_id, company_id) REFERENCES obligations(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (expense_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (debit_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (credit_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  CONSTRAINT personal_payments_treatment_shape CHECK (
    (treatment = 'new_expense' AND document_id IS NOT NULL AND obligation_id IS NULL AND expense_account_id IS NOT NULL)
    OR (treatment = 'existing_obligation' AND obligation_id IS NOT NULL AND document_id IS NULL AND expense_account_id IS NULL)),
  CONSTRAINT personal_payments_state_check CHECK (
    (status = 'draft' AND journal_entry_id IS NULL AND submitted_by IS NULL AND submitted_at IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL
       AND rejection_reason IS NULL AND debit_account_id IS NULL AND credit_account_id IS NULL)
    OR (status = 'submitted' AND journal_entry_id IS NULL AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND reviewed_by IS NULL
       AND reviewed_at IS NULL AND rejection_reason IS NULL)
    OR (status = 'approved' AND journal_entry_id IS NOT NULL AND submitted_by IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
       AND rejection_reason IS NULL AND debit_account_id IS NOT NULL AND credit_account_id IS NOT NULL)
    OR (status = 'rejected' AND journal_entry_id IS NULL AND submitted_by IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
       AND rejection_reason IS NOT NULL AND debit_account_id IS NULL AND credit_account_id IS NULL))
);
CREATE INDEX personal_payments_company_idx ON personal_payments (company_id, status, accounting_date);
CREATE INDEX personal_payments_payer_idx ON personal_payments (company_id, payer_id, accounting_date);
CREATE INDEX personal_payments_obligation_idx ON personal_payments (company_id, obligation_id) WHERE obligation_id IS NOT NULL;
CREATE UNIQUE INDEX personal_payments_journal_uidx ON personal_payments (journal_entry_id) WHERE journal_entry_id IS NOT NULL;
-- A document backs at most one live (not rejected) personal payment.
CREATE UNIQUE INDEX personal_payments_document_uidx ON personal_payments (document_id) WHERE document_id IS NOT NULL AND status <> 'rejected';

CREATE TABLE personal_payment_reimbursements (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payment_id          UUID          NOT NULL,
  bank_transaction_id UUID          NOT NULL,
  amount              NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  reimbursement_date  DATE          NOT NULL,
  debit_account_id    UUID          NOT NULL,
  credit_account_id   UUID          NOT NULL,
  journal_entry_id    UUID,
  note                TEXT          CHECK (note IS NULL OR char_length(note) <= 500),
  created_by          UUID          NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  -- One bank statement row backs at most one reimbursement, ever.
  UNIQUE (bank_transaction_id),
  FOREIGN KEY (payment_id, company_id) REFERENCES personal_payments(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (bank_transaction_id, company_id) REFERENCES bank_transactions(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (debit_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (credit_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  CHECK (debit_account_id <> credit_account_id)
);
CREATE INDEX personal_payment_reimbursements_payment_idx ON personal_payment_reimbursements (company_id, payment_id, reimbursement_date);
CREATE UNIQUE INDEX personal_payment_reimbursements_journal_uidx ON personal_payment_reimbursements (journal_entry_id) WHERE journal_entry_id IS NOT NULL;

-- Append-only workflow history (the audit_log keeps the before/after snapshots).
CREATE TABLE personal_payment_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payment_id       UUID        NOT NULL,
  event_type       TEXT        NOT NULL CHECK (event_type IN ('submitted','approved','rejected','reopened','reimbursed')),
  from_status      TEXT,
  to_status        TEXT,
  actor_user_id    UUID        NOT NULL REFERENCES users(id),
  reason           TEXT        CHECK (reason IS NULL OR char_length(reason) <= 500),
  journal_entry_id UUID,
  reimbursement_id UUID,
  amount           NUMERIC(18,2),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (payment_id, company_id) REFERENCES personal_payments(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX personal_payment_events_payment_idx ON personal_payment_events (company_id, payment_id, created_at);

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------------------------------------------------------

CREATE FUNCTION personal_payment_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'personal payment events are append-only' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER personal_payment_events_immutable BEFORE UPDATE OR DELETE ON personal_payment_events
FOR EACH ROW EXECUTE FUNCTION personal_payment_events_immutable();

-- Workflow and immutability of a payment. Allowed: draft edits, draft -> submitted, submitted -> approved | rejected, rejected -> draft (correction),
-- and, while submitted, only the posting snapshot (debit/credit accounts) changing. An approved payment is never changed again; only drafts are deletable.
CREATE FUNCTION personal_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'a submitted, approved or rejected personal payment cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.company_id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.company_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'personal payment identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'an approved personal payment is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'rejected' AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'a rejected personal payment can only be reopened as a draft' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'submitted' THEN
    IF NEW.status NOT IN ('submitted','approved','rejected') THEN
      RAISE EXCEPTION 'a submitted personal payment can only be approved or rejected' USING ERRCODE = '55000';
    END IF;
    IF (NEW.payer_id, NEW.treatment, NEW.payment_date, NEW.accounting_date, NEW.amount, NEW.currency_code, NEW.purpose, NEW.counterparty_id, NEW.document_id,
        NEW.obligation_id, NEW.expense_account_id, NEW.submitted_by, NEW.submitted_at)
       IS DISTINCT FROM
       (OLD.payer_id, OLD.treatment, OLD.payment_date, OLD.accounting_date, OLD.amount, OLD.currency_code, OLD.purpose, OLD.counterparty_id, OLD.document_id,
        OLD.obligation_id, OLD.expense_account_id, OLD.submitted_by, OLD.submitted_at) THEN
      RAISE EXCEPTION 'a submitted personal payment cannot be edited' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF OLD.status = 'draft' AND NEW.status NOT IN ('draft','submitted') THEN
    RAISE EXCEPTION 'a draft personal payment must be submitted before review' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER personal_payment_guard BEFORE UPDATE OR DELETE ON personal_payments
FOR EACH ROW EXECUTE FUNCTION personal_payment_guard();

-- Payer identity cannot be re-pointed once a payment of the payer is in review or approved.
CREATE FUNCTION personal_payer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.company_id, NEW.user_id, NEW.partner_id, NEW.payable_account_id) IS DISTINCT FROM (OLD.company_id, OLD.user_id, OLD.partner_id, OLD.payable_account_id)
     AND EXISTS (SELECT 1 FROM personal_payments p WHERE p.payer_id = OLD.id AND p.company_id = OLD.company_id AND p.status IN ('submitted','approved')) THEN
    RAISE EXCEPTION 'the payer has payments in review or approved; its account association cannot change' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER personal_payer_guard BEFORE UPDATE ON personal_payers
FOR EACH ROW EXECUTE FUNCTION personal_payer_guard();

-- An existing obligation can only be reclassified for what is still outstanding. The obligation row is locked so approval and settlement serialize.
CREATE FUNCTION personal_payment_obligation_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ob RECORD; settled NUMERIC;
BEGIN
  SELECT * INTO ob FROM obligations WHERE id = NEW.obligation_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND OR ob.direction <> 'payable' OR ob.verification_status <> 'confirmed' OR ob.is_cancelled THEN
    RAISE EXCEPTION 'the obligation is not an open confirmed payable' USING ERRCODE = '23514';
  END IF;
  IF ob.source_type = 'document' THEN
    SELECT COALESCE(SUM(amount), 0) INTO settled FROM document_settlements WHERE document_id = ob.document_id AND company_id = ob.company_id;
  ELSE
    SELECT COALESCE(SUM(amount), 0) INTO settled FROM obligation_settlements WHERE obligation_id = ob.id AND company_id = ob.company_id;
  END IF;
  IF NEW.amount > ob.original_amount + obligation_adjustment_net(ob.id, ob.company_id) - settled THEN
    RAISE EXCEPTION 'the personal payment exceeds the outstanding obligation amount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER personal_payment_obligation_approval_guard BEFORE UPDATE OF status ON personal_payments
FOR EACH ROW WHEN (NEW.status = 'approved' AND OLD.status <> 'approved' AND NEW.obligation_id IS NOT NULL)
EXECUTE FUNCTION personal_payment_obligation_approval_guard();

-- Reclassified obligations: later settlements cannot exceed the reduced outstanding amount, and the obligation cannot be cancelled or un-confirmed.
CREATE FUNCTION personal_payment_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ob RECORD; prior NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'document_settlements' THEN
    SELECT * INTO ob FROM obligations WHERE document_id = NEW.document_id AND company_id = NEW.company_id AND source_type = 'document' FOR UPDATE;
  ELSE
    SELECT * INTO ob FROM obligations WHERE id = NEW.obligation_id AND company_id = NEW.company_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM personal_payments p WHERE p.obligation_id = ob.id AND p.company_id = ob.company_id AND p.status = 'approved') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'document_settlements' THEN
    SELECT COALESCE(SUM(amount), 0) INTO prior FROM document_settlements WHERE document_id = NEW.document_id AND company_id = NEW.company_id AND id <> NEW.id;
  ELSE
    SELECT COALESCE(SUM(amount), 0) INTO prior FROM obligation_settlements WHERE obligation_id = NEW.obligation_id AND company_id = NEW.company_id AND id <> NEW.id;
  END IF;
  IF prior + NEW.amount > ob.original_amount + obligation_adjustment_net(ob.id, ob.company_id) THEN
    RAISE EXCEPTION 'the settlement exceeds the amount outstanding after personal payments' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER personal_payment_settlement_guard BEFORE INSERT OR UPDATE ON obligation_settlements
FOR EACH ROW EXECUTE FUNCTION personal_payment_settlement_guard();
CREATE TRIGGER personal_payment_settlement_guard BEFORE INSERT OR UPDATE ON document_settlements
FOR EACH ROW EXECUTE FUNCTION personal_payment_settlement_guard();

CREATE FUNCTION personal_payment_obligation_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM personal_payments p WHERE p.obligation_id = OLD.id AND p.company_id = OLD.company_id AND p.status = 'approved') THEN
    RAISE EXCEPTION 'the obligation was reclassified by an approved personal payment; it cannot be cancelled or un-confirmed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER personal_payment_obligation_status_guard BEFORE UPDATE OF is_cancelled, verification_status ON obligations
FOR EACH ROW WHEN ((NEW.is_cancelled AND NOT OLD.is_cancelled) OR (NEW.verification_status = 'unconfirmed' AND OLD.verification_status = 'confirmed'))
EXECUTE FUNCTION personal_payment_obligation_status_guard();

-- Document exclusivity, both directions, serialized per document. A document recognized by an obligation, custody allocation, bank settlement or invoice
-- cannot back a personal payment, and the reverse.
CREATE FUNCTION personal_payment_document_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('personal-payment-document:' || NEW.document_id::text, 0));
  IF EXISTS (SELECT 1 FROM obligations o WHERE o.document_id = NEW.document_id AND o.company_id = NEW.company_id AND NOT o.is_cancelled)
     OR EXISTS (SELECT 1 FROM custody_document_allocations a WHERE a.document_id = NEW.document_id AND a.company_id = NEW.company_id)
     OR EXISTS (SELECT 1 FROM document_settlements s WHERE s.document_id = NEW.document_id AND s.company_id = NEW.company_id)
     OR EXISTS (SELECT 1 FROM invoice_source_links l WHERE l.document_id = NEW.document_id AND l.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'the document is already recognized by another workflow' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER personal_payment_document_claim BEFORE INSERT OR UPDATE OF document_id, status ON personal_payments
FOR EACH ROW WHEN (NEW.document_id IS NOT NULL AND NEW.status <> 'rejected') EXECUTE FUNCTION personal_payment_document_claim();

CREATE FUNCTION personal_payment_document_claim_reverse() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc UUID;
BEGIN
  doc := (to_jsonb(NEW) ->> 'document_id')::uuid;
  IF doc IS NULL OR COALESCE((to_jsonb(NEW) ->> 'is_cancelled')::boolean, FALSE) THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('personal-payment-document:' || doc::text, 0));
  IF EXISTS (SELECT 1 FROM personal_payments p WHERE p.document_id = doc AND p.company_id = NEW.company_id AND p.status <> 'rejected') THEN
    RAISE EXCEPTION 'the document is already recognized by a personal payment' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER personal_payment_document_claim_reverse BEFORE INSERT OR UPDATE OF document_id, is_cancelled ON obligations
FOR EACH ROW EXECUTE FUNCTION personal_payment_document_claim_reverse();
CREATE TRIGGER personal_payment_document_claim_reverse BEFORE INSERT ON custody_document_allocations
FOR EACH ROW EXECUTE FUNCTION personal_payment_document_claim_reverse();
CREATE TRIGGER personal_payment_document_claim_reverse BEFORE INSERT ON document_settlements
FOR EACH ROW EXECUTE FUNCTION personal_payment_document_claim_reverse();
CREATE TRIGGER personal_payment_document_claim_reverse BEFORE INSERT ON invoice_source_links
FOR EACH ROW EXECUTE FUNCTION personal_payment_document_claim_reverse();

-- Reimbursement: immutable except the one-time link to its journal.
CREATE FUNCTION personal_payment_reimbursement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN
      RAISE EXCEPTION 'a personal payment reimbursement cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.journal_entry_id IS NULL AND NEW.journal_entry_id IS NOT NULL
     AND (NEW.id, NEW.company_id, NEW.payment_id, NEW.bank_transaction_id, NEW.amount, NEW.reimbursement_date, NEW.debit_account_id, NEW.credit_account_id, NEW.note, NEW.created_by, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.company_id, OLD.payment_id, OLD.bank_transaction_id, OLD.amount, OLD.reimbursement_date, OLD.debit_account_id, OLD.credit_account_id, OLD.note, OLD.created_by, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a personal payment reimbursement is immutable' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER personal_payment_reimbursement_guard BEFORE UPDATE OR DELETE ON personal_payment_reimbursements
FOR EACH ROW EXECUTE FUNCTION personal_payment_reimbursement_guard();

-- Over-reimbursement guard: the payment row is locked, so concurrent reimbursements of one payment are strictly ordered.
CREATE FUNCTION personal_payment_reimbursement_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pay RECORD; prior NUMERIC;
BEGIN
  SELECT * INTO pay FROM personal_payments WHERE id = NEW.payment_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND OR pay.status <> 'approved' THEN
    RAISE EXCEPTION 'only an approved personal payment can be reimbursed' USING ERRCODE = '23514';
  END IF;
  IF NEW.reimbursement_date < pay.accounting_date THEN
    RAISE EXCEPTION 'the reimbursement cannot precede the payment' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO prior FROM personal_payment_reimbursements WHERE payment_id = NEW.payment_id AND company_id = NEW.company_id;
  IF prior + NEW.amount > pay.amount THEN
    RAISE EXCEPTION 'the reimbursement exceeds the outstanding amount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER personal_payment_reimbursement_limit BEFORE INSERT ON personal_payment_reimbursements
FOR EACH ROW EXECUTE FUNCTION personal_payment_reimbursement_limit();

-- Bank statement row exclusivity (same serialisation as 017/087: lock the bank transaction row, then check). Also: company outflow of exactly the amount.
CREATE FUNCTION personal_payment_reimbursement_bank_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bt RECORD;
BEGIN
  SELECT * INTO bt FROM bank_transactions WHERE id = NEW.bank_transaction_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND OR bt.amount >= 0 OR -bt.amount <> NEW.amount OR bt.transaction_date <> NEW.reimbursement_date THEN
    RAISE EXCEPTION 'the bank transaction must be a company outflow of exactly the reimbursement amount and date' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM bank_transaction_matches WHERE bank_transaction_id = NEW.bank_transaction_id)
     OR EXISTS (SELECT 1 FROM document_settlements WHERE bank_transaction_id = NEW.bank_transaction_id)
     OR EXISTS (SELECT 1 FROM obligation_settlements WHERE bank_transaction_id = NEW.bank_transaction_id)
     OR EXISTS (SELECT 1 FROM partner_transactions WHERE bank_transaction_id = NEW.bank_transaction_id AND status IN ('draft','posted')) THEN
    RAISE EXCEPTION 'bank transaction already explained' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER personal_payment_reimbursement_bank_guard BEFORE INSERT ON personal_payment_reimbursements
FOR EACH ROW EXECUTE FUNCTION personal_payment_reimbursement_bank_guard();

-- The other workflows learn about reimbursements (CREATE OR REPLACE of the 087 bodies, one added check each).
CREATE OR REPLACE FUNCTION partner_transaction_bank_exclusivity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bank_transaction_id IS NULL OR NEW.status NOT IN ('draft','posted') THEN RETURN NEW; END IF;
  PERFORM 1 FROM bank_transactions WHERE id = NEW.bank_transaction_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM bank_transaction_matches WHERE bank_transaction_id = NEW.bank_transaction_id)
     OR EXISTS (SELECT 1 FROM document_settlements WHERE bank_transaction_id = NEW.bank_transaction_id)
     OR EXISTS (SELECT 1 FROM obligation_settlements WHERE bank_transaction_id = NEW.bank_transaction_id)
     OR EXISTS (SELECT 1 FROM personal_payment_reimbursements WHERE bank_transaction_id = NEW.bank_transaction_id) THEN
    RAISE EXCEPTION 'bank transaction already explained' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION partner_bank_transaction_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM bank_transactions WHERE id = NEW.bank_transaction_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM partner_transactions WHERE bank_transaction_id = NEW.bank_transaction_id AND status IN ('draft','posted')) THEN
    RAISE EXCEPTION 'bank transaction already explained by a partner transaction' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM personal_payment_reimbursements WHERE bank_transaction_id = NEW.bank_transaction_id) THEN
    RAISE EXCEPTION 'bank transaction already explained by a personal payment reimbursement' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;

-- Outstanding obligation amounts: approved personal payments dated on or before the as-of date reduce the obligation (all existing readers already
-- compute original + obligation_adjustment_net() - settled). Invoice credit/debit notes behave exactly as in 072.
CREATE OR REPLACE FUNCTION obligation_adjustment_net(p_obligation UUID, p_company UUID, p_as_of DATE DEFAULT NULL) RETURNS NUMERIC AS $$
  SELECT COALESCE((SELECT SUM(CASE a.adjustment_type WHEN 'debit' THEN a.total_amount ELSE -a.total_amount END)
                     FROM obligations o JOIN invoice_adjustments a ON a.original_invoice_id = o.invoice_id AND a.company_id = o.company_id AND a.status = 'approved'
                    WHERE o.id = p_obligation AND o.company_id = p_company AND o.source_type = 'invoice' AND (p_as_of IS NULL OR a.adjustment_date <= p_as_of)), 0)
       - COALESCE((SELECT SUM(p.amount) FROM personal_payments p
                    WHERE p.obligation_id = p_obligation AND p.company_id = p_company AND p.status = 'approved' AND (p_as_of IS NULL OR p.accounting_date <= p_as_of)), 0);
$$ LANGUAGE sql STABLE;
