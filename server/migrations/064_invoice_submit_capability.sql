-- Migration 064 (PR-3A): registers invoice.submit as an explicit-grant-only capability (see 063).
-- No role_capabilities rows are inserted: the permission starts unassigned in every company.
-- invoice.approve is intentionally NOT registered here: final approval stays disabled until the owner
-- decides the account-mapping and VAT policies it depends on.
-- Rollback: DELETE FROM capabilities WHERE id = 'invoice.submit' (cascades any explicit grants).

INSERT INTO capabilities (id, implicit_full_access) VALUES ('invoice.submit', FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access = FALSE;
