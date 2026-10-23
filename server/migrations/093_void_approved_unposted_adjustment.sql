-- Migration 093 (Invoice VAT V3.3): cancel an APPROVED credit / debit note while its own journal is still a DRAFT. Additive and narrow.
--   * journal_entries.status gains 'voided' (draft -> voided only, only for the journal of an invoice_adjustment, only inside the controlled
--     cancellation transaction). The journal and its lines are kept untouched; voided and posted journals are immutable and never deleted.
--   * invoice_adjustments may go approved -> cancelled ONLY through that same controlled path (transaction-local setting eqfal.adjustment_void =
--     the note id, set by InvoiceAdjustmentService.voidApproved). Internal and external numbers, approval data and all amounts stay as they were.
--   * The settlement guard now locks the obligation row so settlements serialize with the cancellation.
--   * Deferred backstops at commit: the note's journal is 'voided', and the invoice's settlements do not exceed original +/- remaining notes.
--   * New capability invoice.adjust_void (registered only: no default role receives it, Full Access holds it through the wildcard). No data row is changed.
-- Rollback (only while no voided journal / cancelled-after-approval note exists): DROP TRIGGER invoice_adjustment_void_consistency,
--   journal_entries_void_guard; DROP FUNCTION check_invoice_adjustment_void(), guard_journal_void(); DROP the voided_* columns and
--   journal_entries_voided_fields_check / journal_entries_voided_source_check; restore the 021/079 protect_posted_journal*() bodies, the 021
--   status CHECK and journal_entries_check1; restore guard_invoice_obligation_adjusted_settlement() from 072 (no FOR UPDATE); restore invoice_adjustments_approval_fields_check (072/062), invoice_adjustments_internal_number_state_check
--   (092) and guard_invoice_adjustment() (092); DELETE FROM capabilities WHERE id = 'invoice.adjust_void'.

-- Registration only (like 079): no role_capabilities row, so no default role gains it; Full Access holds it through the wildcard (075).
INSERT INTO capabilities (id) VALUES ('invoice.adjust_void') ON CONFLICT (id) DO NOTHING;

-- 1) Journal status 'voided'.
ALTER TABLE journal_entries
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by UUID REFERENCES users(id),
  ADD COLUMN void_reason TEXT CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 1 AND 500);
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_status_check;
ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_check1;
ALTER TABLE journal_entries
  ADD CONSTRAINT journal_entries_status_check CHECK (status IN ('draft','posted','voided')) NOT VALID,
  ADD CONSTRAINT journal_entries_check1 CHECK (
    (status IN ('draft','voided') AND posted_by IS NULL AND posted_at IS NULL)
    OR (status = 'posted' AND posted_by IS NOT NULL AND posted_at IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT journal_entries_voided_fields_check CHECK (
    (status = 'voided') = (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT journal_entries_voided_source_check CHECK (status <> 'voided' OR (source_type = 'invoice_adjustment' AND source_id IS NOT NULL)) NOT VALID;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_status_check;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_check1;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_voided_fields_check;
ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_voided_source_check;

-- Voided journals are as immutable as posted ones (header, lines, no delete). Draft -> voided stays possible because OLD.status is 'draft'.
CREATE OR REPLACE FUNCTION protect_posted_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN RAISE EXCEPTION 'posted journal is immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status = 'voided' THEN RAISE EXCEPTION 'voided journal is immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION protect_posted_journal_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry_status TEXT;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT status INTO entry_status FROM journal_entries WHERE id=NEW.journal_entry_id AND company_id=NEW.company_id;
    IF entry_status IN ('posted','voided') THEN RAISE EXCEPTION '% journal is immutable', entry_status USING ERRCODE='55000'; END IF;
    RETURN NEW;
  ELSIF TG_OP='DELETE' THEN
    SELECT status INTO entry_status FROM journal_entries WHERE id=OLD.journal_entry_id AND company_id=OLD.company_id;
    IF entry_status IN ('posted','voided') THEN RAISE EXCEPTION '% journal is immutable', entry_status USING ERRCODE='55000'; END IF;
    RETURN OLD;
  ELSIF TG_OP='UPDATE' THEN
    SELECT status INTO entry_status FROM journal_entries WHERE id=OLD.journal_entry_id AND company_id=OLD.company_id;
    IF entry_status IN ('posted','voided') THEN RAISE EXCEPTION '% journal is immutable', entry_status USING ERRCODE='55000'; END IF;
    SELECT status INTO entry_status FROM journal_entries WHERE id=NEW.journal_entry_id AND company_id=NEW.company_id;
    IF entry_status IN ('posted','voided') THEN RAISE EXCEPTION '% journal is immutable', entry_status USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
END $$;

-- The only way a journal becomes voided: its own note is already cancelled in this transaction through the controlled path, the journal was a
-- draft, and nothing but the status and the void columns changes. A journal can never be inserted as voided, and the journal of a note that is
-- no longer approved can never become posted.
CREATE FUNCTION guard_journal_void() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE note_status TEXT; old_j JSONB; new_j JSONB; meta TEXT[] := ARRAY['status','voided_at','voided_by','void_reason','updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'a journal cannot be created as voided' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'voided' THEN
    IF OLD.status <> 'draft' OR OLD.source_type IS DISTINCT FROM 'invoice_adjustment' THEN
      RAISE EXCEPTION 'only the draft journal of a credit/debit note can be voided' USING ERRCODE = '23514';
    END IF;
    IF current_setting('eqfal.adjustment_void', true) IS DISTINCT FROM OLD.source_id::text THEN
      RAISE EXCEPTION 'a note journal is voided only by the controlled note cancellation' USING ERRCODE = '23514';
    END IF;
    SELECT status INTO note_status FROM invoice_adjustments WHERE id = OLD.source_id AND company_id = OLD.company_id;
    IF note_status IS DISTINCT FROM 'cancelled' THEN
      RAISE EXCEPTION 'the note must be cancelled before its journal is voided' USING ERRCODE = '23514';
    END IF;
    old_j := to_jsonb(OLD); new_j := to_jsonb(NEW);
    IF (old_j - meta) <> (new_j - meta) THEN
      RAISE EXCEPTION 'voiding cannot alter the journal' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'posted' AND NEW.source_type = 'invoice_adjustment' THEN
    SELECT status INTO note_status FROM invoice_adjustments WHERE id = NEW.source_id AND company_id = NEW.company_id;
    IF note_status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'the journal of a note that is not approved cannot be posted' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_void_guard_insert BEFORE INSERT ON journal_entries
  FOR EACH ROW WHEN (NEW.status = 'voided') EXECUTE FUNCTION guard_journal_void();
CREATE TRIGGER journal_entries_void_guard BEFORE UPDATE OF status ON journal_entries
  FOR EACH ROW WHEN (NEW.status = 'voided' OR (NEW.status = 'posted' AND NEW.source_type = 'invoice_adjustment')) EXECUTE FUNCTION guard_journal_void();

-- 2) Notes: approved -> cancelled through the controlled path only.
ALTER TABLE invoice_adjustments DROP CONSTRAINT invoice_adjustments_approval_fields_check;
ALTER TABLE invoice_adjustments ADD CONSTRAINT invoice_adjustments_approval_fields_check CHECK (
  (status = 'approved' AND approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL)
  OR (status = 'draft' AND approved_at IS NULL AND approved_by_user_id IS NULL)
  OR (status = 'cancelled' AND (approved_at IS NULL) = (approved_by_user_id IS NULL))) NOT VALID;
ALTER TABLE invoice_adjustments VALIDATE CONSTRAINT invoice_adjustments_approval_fields_check;
-- A cancelled note keeps the internal number it was approved with (the counter never decreases, so the number is never reused).
ALTER TABLE invoice_adjustments DROP CONSTRAINT invoice_adjustments_internal_number_state_check;
ALTER TABLE invoice_adjustments ADD CONSTRAINT invoice_adjustments_internal_number_state_check
  CHECK (internal_number IS NULL OR (status IN ('approved','cancelled') AND fiscal_year_id IS NOT NULL AND (status = 'approved' OR approved_at IS NOT NULL)));

-- guard_invoice_adjustment(): identical to 092 except that an APPROVED note may become cancelled when the transaction-local setting
-- eqfal.adjustment_void names this note and only the cancellation columns change. Cancelled notes stay immutable.
CREATE OR REPLACE FUNCTION guard_invoice_adjustment() RETURNS trigger AS $$
DECLARE
  meta_keys TEXT[] := ARRAY['updated_at','version'];
  approval_keys TEXT[] := ARRAY['status','approved_by_user_id','approved_at','fiscal_year_id','internal_number'];
  cancel_keys TEXT[] := ARRAY['status','cancelled_by_user_id','cancelled_at','cancellation_reason'];
  old_j JSONB; new_j JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'a note is registered as a draft' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN RETURN OLD; END IF;
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'only draft adjustments can be deleted' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'cancelled'
     AND current_setting('eqfal.adjustment_void', true) IS NOT DISTINCT FROM OLD.id::text
     AND (to_jsonb(OLD) - meta_keys - cancel_keys) = (to_jsonb(NEW) - meta_keys - cancel_keys) THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('approved','cancelled') THEN
    RAISE EXCEPTION 'approved or cancelled adjustments are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.original_invoice_id <> OLD.original_invoice_id
     OR NEW.direction <> OLD.direction OR NEW.adjustment_type <> OLD.adjustment_type THEN
    RAISE EXCEPTION 'adjustment identity columns are immutable' USING ERRCODE = '23514';
  END IF;
  old_j := to_jsonb(OLD); new_j := to_jsonb(NEW);
  IF NEW.status = 'approved' AND (old_j - meta_keys - approval_keys) <> (new_j - meta_keys - approval_keys) THEN
    RAISE EXCEPTION 'approval cannot also alter the adjustment' USING ERRCODE = '23514';
  ELSIF NEW.status = 'cancelled' AND (old_j - meta_keys - cancel_keys) <> (new_j - meta_keys - cancel_keys) THEN
    RAISE EXCEPTION 'cancellation cannot also alter the adjustment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- Commit-time backstops for an approved -> cancelled transition: the note's own journal ended up 'voided' (never posted, never left as a draft that
-- would block closing), and the invoice's settlements still fit original +/- remaining approved notes - approved personal payments.
CREATE FUNCTION check_invoice_adjustment_void() RETURNS trigger AS $$
DECLARE j_status TEXT; ob RECORD; settled NUMERIC;
BEGIN
  SELECT status INTO j_status FROM journal_entries WHERE company_id = NEW.company_id AND source_type = 'invoice_adjustment' AND source_id = NEW.id;
  IF j_status IS DISTINCT FROM 'voided' THEN
    RAISE EXCEPTION 'an approved note can be cancelled only together with voiding its draft journal' USING ERRCODE = '23514';
  END IF;
  SELECT id, original_amount INTO ob FROM obligations WHERE invoice_id = NEW.original_invoice_id AND company_id = NEW.company_id AND source_type = 'invoice';
  IF FOUND THEN
    SELECT COALESCE(SUM(amount), 0) INTO settled FROM obligation_settlements WHERE obligation_id = ob.id AND company_id = NEW.company_id;
    IF settled > ob.original_amount + obligation_adjustment_net(ob.id, NEW.company_id) THEN
      RAISE EXCEPTION 'cancelling the note would leave settlements above the adjusted invoice amount' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER invoice_adjustment_void_consistency AFTER UPDATE ON invoice_adjustments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status = 'approved' AND NEW.status = 'cancelled') EXECUTE FUNCTION check_invoice_adjustment_void();

-- Settlement guard (072): identical, except that it now takes the obligation row lock (FOR UPDATE). The application settlement path already holds it;
-- this makes ANY insert/update of a settlement serialize with the note cancellation (which also locks the obligation) so the adjusted amount a settlement
-- is checked against cannot change underneath it. READ COMMITTED re-reads obligation_adjustment_net after the wait.
CREATE OR REPLACE FUNCTION guard_invoice_obligation_adjusted_settlement() RETURNS trigger AS $$
DECLARE ob RECORD; prior NUMERIC;
BEGIN
  SELECT original_amount, source_type INTO ob FROM obligations WHERE id = NEW.obligation_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND OR ob.source_type <> 'invoice' THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO prior FROM obligation_settlements WHERE obligation_id = NEW.obligation_id AND company_id = NEW.company_id AND id <> NEW.id;
  IF prior + NEW.amount > ob.original_amount + obligation_adjustment_net(NEW.obligation_id, NEW.company_id) THEN
    RAISE EXCEPTION 'settlement exceeds the adjusted invoice amount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
