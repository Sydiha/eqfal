-- Migration 065: company-specific account mappings for invoice accounting (additive, structure only).
-- Inserts NO rows: no company has any mapping until an authorized person sets one, and nothing reads this table to
-- post or create journals yet. Which accounts to use, and what happens when a mapping is missing, are open owner
-- decisions (A1). The key list is a proposal; widening it later is a one-line CHECK change.
-- Rollback: DROP TABLE invoice_account_mappings;

CREATE TABLE invoice_account_mappings (
  company_id         UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mapping_key        TEXT        NOT NULL CHECK (mapping_key IN ('receivable','payable','sales_revenue','purchase_expense','vat_output','vat_input')),
  account_id         UUID        NOT NULL,
  updated_by_user_id UUID        NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, mapping_key),
  -- composite FK: the mapped account must belong to the same company
  CONSTRAINT invoice_account_mappings_account_fk FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);
