-- Migration 070 (F1): registers invoice.approve as an explicit-grant-only capability (see 063/064).
-- No role_capabilities rows are inserted: the permission starts unassigned in every company, Full Access included.
-- Approval additionally requires obligation.confirm and accounting.journal.create (checked by InvoiceApprovalService).
-- Rollback: DELETE FROM capabilities WHERE id = 'invoice.approve' (cascades any explicit grants).

INSERT INTO capabilities (id, implicit_full_access) VALUES ('invoice.approve', FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access = FALSE;
