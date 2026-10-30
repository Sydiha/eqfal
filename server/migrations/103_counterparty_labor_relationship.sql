-- Migration 103: optional labor-related relationship classification on counterparties (G8).
-- Nullable informational tag only: NULL for every existing and ordinary counterparty. It is NOT payroll, salary or employment status and does not
-- affect journals, VAT, WHT, aging totals or closing. Rollback: ALTER TABLE counterparties DROP COLUMN labor_relationship;
ALTER TABLE counterparties
  ADD COLUMN labor_relationship TEXT NULL
  CONSTRAINT counterparties_labor_relationship_check CHECK (labor_relationship IS NULL OR labor_relationship IN ('labor_supply','contractor','individual','unresolved'));
