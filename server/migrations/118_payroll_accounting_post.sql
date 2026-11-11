-- Explicit authority only; no role grants. The existing journal source unique index enforces idempotency.
INSERT INTO capabilities(id,implicit_full_access) VALUES ('payroll.accounting.post',FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access=FALSE;
