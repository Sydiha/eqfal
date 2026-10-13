-- Migration 071 (F4): registers invoice.cancel as an explicit-grant-only capability (see 063/064/070).
-- No role_capabilities rows are inserted: the permission starts unassigned in every company, Full Access included.
-- No table, trigger or guard is changed: cancelling a draft or submitted invoice only uses the draft/submitted -> cancelled
-- transition and the cancellation columns that migration 062 already provides.
-- Rollback: DELETE FROM capabilities WHERE id = 'invoice.cancel' (cascades any explicit grants).

INSERT INTO capabilities (id, implicit_full_access) VALUES ('invoice.cancel', FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access = FALSE;
