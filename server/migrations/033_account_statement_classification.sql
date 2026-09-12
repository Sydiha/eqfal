-- Phase 5A: financial-statement presentation mapping for chart of accounts.
ALTER TABLE accounts
  ADD COLUMN statement_category TEXT NOT NULL DEFAULT 'unmapped',
  ADD COLUMN is_contra BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_statement_category_check CHECK (
    statement_category IN (
      'unmapped',
      'current_asset',
      'non_current_asset',
      'current_liability',
      'non_current_liability',
      'equity',
      'revenue',
      'cost_of_sales',
      'operating_expense',
      'finance_income',
      'finance_expense',
      'other_income',
      'other_expense'
    )
  ),
  ADD CONSTRAINT accounts_statement_category_type_check CHECK (
    (account_type = 'asset' AND statement_category IN ('unmapped','current_asset','non_current_asset')) OR
    (account_type = 'liability' AND statement_category IN ('unmapped','current_liability','non_current_liability')) OR
    (account_type = 'equity' AND statement_category IN ('unmapped','equity')) OR
    (account_type = 'revenue' AND statement_category IN ('unmapped','revenue','finance_income','other_income')) OR
    (account_type = 'expense' AND statement_category IN ('unmapped','cost_of_sales','operating_expense','finance_expense','other_expense'))
  ),
  ADD CONSTRAINT accounts_contra_asset_check CHECK (
    NOT is_contra OR account_type = 'asset'
  );

CREATE INDEX accounts_company_statement_category_idx
  ON accounts(company_id, statement_category, code, id);
