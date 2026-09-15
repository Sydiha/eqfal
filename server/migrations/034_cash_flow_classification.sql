-- Phase 5D.1: explicit cash and default cash-flow classification metadata.
ALTER TABLE accounts
  ADD COLUMN cash_role TEXT NOT NULL DEFAULT 'non_cash',
  ADD COLUMN cash_flow_category TEXT NOT NULL DEFAULT 'unmapped';

ALTER TABLE accounts
  ADD CONSTRAINT accounts_cash_role_check CHECK (
    cash_role IN ('non_cash','cash','cash_equivalent')
  ),
  ADD CONSTRAINT accounts_cash_flow_category_check CHECK (
    cash_flow_category IN ('unmapped','operating','investing','financing')
  ),
  ADD CONSTRAINT accounts_cash_role_asset_check CHECK (
    cash_role = 'non_cash' OR account_type = 'asset'
  );

CREATE INDEX accounts_company_cash_flow_classification_idx
  ON accounts(company_id, cash_role, cash_flow_category, code, id);
