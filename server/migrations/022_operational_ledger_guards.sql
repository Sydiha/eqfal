-- Prevent a posted ledger entry from silently diverging from its operational source.
CREATE OR REPLACE FUNCTION guard_posted_operational_source() RETURNS trigger AS $$
DECLARE source_kind text := TG_ARGV[0]; source_uuid uuid := COALESCE(OLD.id, NEW.id); source_company uuid := COALESCE(OLD.company_id, NEW.company_id);
BEGIN
  IF EXISTS (SELECT 1 FROM journal_entries WHERE company_id=source_company AND source_type=source_kind AND source_id=source_uuid AND status='posted') THEN
    RAISE EXCEPTION 'posted operational source is immutable' USING ERRCODE='23505';
  END IF;
  RETURN COALESCE(NEW,OLD);
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER posted_obligation_guard BEFORE UPDATE OF original_amount,recognized_on,verification_status,is_cancelled,counterparty_id,direction,source_type,document_id OR DELETE ON obligations FOR EACH ROW EXECUTE FUNCTION guard_posted_operational_source('obligation');
CREATE TRIGGER posted_document_settlement_guard BEFORE UPDATE OF amount,document_id,bank_transaction_id OR DELETE ON document_settlements FOR EACH ROW EXECUTE FUNCTION guard_posted_operational_source('document_settlement');
CREATE TRIGGER posted_obligation_settlement_guard BEFORE UPDATE OF amount,obligation_id,bank_transaction_id OR DELETE ON obligation_settlements FOR EACH ROW EXECUTE FUNCTION guard_posted_operational_source('obligation_settlement');
CREATE TRIGGER posted_custody_allocation_guard BEFORE UPDATE OF amount,custody_id,document_id OR DELETE ON custody_document_allocations FOR EACH ROW EXECUTE FUNCTION guard_posted_operational_source('custody_allocation');
CREATE OR REPLACE FUNCTION guard_posted_custody_match() RETURNS trigger AS $$
BEGIN
  IF OLD.match_type IN ('custody_funding','custody_return') AND EXISTS(SELECT 1 FROM journal_entries WHERE company_id=OLD.company_id AND source_type=OLD.match_type AND source_id=OLD.id AND status='posted')
  THEN RAISE EXCEPTION 'posted operational source is immutable' USING ERRCODE='23505'; END IF;
  RETURN COALESCE(NEW,OLD);
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER posted_custody_match_guard BEFORE UPDATE OF bank_transaction_id,custody_id,match_type OR DELETE ON bank_transaction_matches FOR EACH ROW EXECUTE FUNCTION guard_posted_custody_match();

CREATE OR REPLACE FUNCTION guard_posted_bank_transaction() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM journal_entries j
    WHERE j.company_id=OLD.company_id AND j.status='posted' AND (
      (j.source_type='document_settlement' AND EXISTS(SELECT 1 FROM document_settlements s WHERE s.id=j.source_id AND s.bank_transaction_id=OLD.id AND s.company_id=OLD.company_id)) OR
      (j.source_type='obligation_settlement' AND EXISTS(SELECT 1 FROM obligation_settlements s WHERE s.id=j.source_id AND s.bank_transaction_id=OLD.id AND s.company_id=OLD.company_id)) OR
      (j.source_type IN ('custody_funding','custody_return') AND EXISTS(SELECT 1 FROM bank_transaction_matches m WHERE m.id=j.source_id AND m.bank_transaction_id=OLD.id AND m.company_id=OLD.company_id))
    )) THEN RAISE EXCEPTION 'posted operational source is immutable' USING ERRCODE='23505'; END IF;
  RETURN COALESCE(NEW,OLD);
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER posted_bank_transaction_guard BEFORE UPDATE OF amount,transaction_date OR DELETE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION guard_posted_bank_transaction();

CREATE OR REPLACE FUNCTION guard_posted_allocation_document_date() RETURNS trigger AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM custody_document_allocations a JOIN journal_entries j ON j.company_id=a.company_id AND j.source_type='custody_allocation' AND j.source_id=a.id AND j.status='posted' WHERE a.document_id=OLD.id AND a.company_id=OLD.company_id)
  THEN RAISE EXCEPTION 'posted operational source is immutable' USING ERRCODE='23505'; END IF;
  RETURN COALESCE(NEW,OLD);
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER posted_allocation_document_date_guard BEFORE UPDATE OF document_date OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION guard_posted_allocation_document_date();
