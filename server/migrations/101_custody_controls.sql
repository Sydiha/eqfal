-- Migration 101: D4/Q5 custody accounting controls.
-- 1) custody_advances.recipient_user_id: the actual recipient of the advance, chosen explicitly. NULL on every existing row (no recipient is guessed
--    or back-filled); holder_user_id of existing rows is left exactly as stored.
-- 2) custody_account_mappings: the company's explicitly configured employee-advances/custody ledger account (one per company; the accountant chooses it).
--    No account is created, inferred from a name, or hardcoded. Eligibility (active, asset, current_asset) is enforced by the service and at journal posting.
-- No capability is added (custody.view / custody.close / accounting.chart.edit are reused). No journal, bank match, allocation or settlement row is touched.
-- Rollback (only while no custody_account_mappings row exists and no custody row has a recipient): DROP TABLE custody_account_mappings;
-- ALTER TABLE custody_advances DROP CONSTRAINT custody_advances_recipient_member_fk, DROP COLUMN recipient_user_id.

ALTER TABLE custody_advances ADD COLUMN recipient_user_id UUID;
ALTER TABLE custody_advances ADD CONSTRAINT custody_advances_recipient_member_fk
  FOREIGN KEY (recipient_user_id, company_id) REFERENCES memberships(user_id, company_id) ON DELETE RESTRICT;

CREATE TABLE custody_account_mappings (
  company_id         UUID        PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  account_id         UUID        NOT NULL,
  updated_by_user_id UUID        NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);
