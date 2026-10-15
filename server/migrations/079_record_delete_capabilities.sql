-- Migration 079 (Delete & Void Phase 3): registers the capabilities for permanently deleting records that never had financial effect:
-- accounting.journal.delete (manual DRAFT journal), periodic_adjustment.delete (DRAFT accrual/prepayment), bank.import.delete (unconfirmed import batch),
-- counterparty.delete and partner.delete (records with no reference from any table).
-- Registration only. No role_capabilities row is inserted, so no default role (Viewer, Accountant, Finance Manager, Company Manager) gains them;
-- Full Access holds them through the wildcard like every registered capability (migration 075).
-- No table or trigger changes: posted journals stay protected by journal_entries_posted_immutable, and the service refuses any record
-- referenced by another table (FK catalog scan), so nothing cascades into financial data.
-- Rollback: DELETE FROM capabilities WHERE id IN (...) (cascades any explicit grants).

INSERT INTO capabilities (id) VALUES
  ('accounting.journal.delete'),
  ('periodic_adjustment.delete'),
  ('bank.import.delete'),
  ('counterparty.delete'),
  ('partner.delete')
ON CONFLICT (id) DO NOTHING;

-- Draft journal deletion fix. protect_posted_journal() (021) ends with RETURN NEW, which is NULL in a BEFORE DELETE trigger, so a DELETE of a
-- DRAFT journal was silently skipped (0 rows, no error). The posted-journal protection is unchanged: a posted row still raises 55000 for UPDATE and
-- DELETE. Only the non-posted DELETE path now returns OLD so that a draft can actually be removed. Trigger and function names are kept.
-- Rollback: re-create the function with the 021 body (RETURN NEW).
CREATE OR REPLACE FUNCTION protect_posted_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'posted' THEN RAISE EXCEPTION 'posted journal is immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
