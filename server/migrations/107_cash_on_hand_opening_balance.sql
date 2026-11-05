-- UAT-007: add physical cash as an opening balance category. Existing rows and category values are unchanged.
ALTER TABLE opening_balance_items
  DROP CONSTRAINT opening_balance_items_category_check;

ALTER TABLE opening_balance_items
  ADD CONSTRAINT opening_balance_items_category_check
  CHECK (category IN (
    'bank','cash_on_hand','receivable','payable','partner_capital','partner_current','partner_loan',
    'custody_advance','vat_tax','inventory','fixed_asset_cost','accumulated_depreciation',
    'other_asset','other_liability','equity'
  ));
