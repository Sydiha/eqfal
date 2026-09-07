-- Phase 1C corrective migration: opening-balance category coverage and traceability

ALTER TABLE opening_balance_items
  DROP CONSTRAINT opening_balance_items_category_check;

ALTER TABLE opening_balance_items
  ADD CONSTRAINT opening_balance_items_category_check
  CHECK (category IN (
    'bank','receivable','payable','partner_capital','partner_current','partner_loan',
    'custody_advance','vat_tax','inventory','fixed_asset_cost','accumulated_depreciation',
    'other_asset','other_liability','equity'
  ));

ALTER TABLE opening_balance_items
  ADD COLUMN obligation_id UUID,
  ADD COLUMN custody_id UUID;

ALTER TABLE opening_balance_items
  ADD CONSTRAINT opening_balance_items_obligation_id_company_id_fkey
  FOREIGN KEY (obligation_id, company_id)
    REFERENCES obligations(id, company_id) ON DELETE RESTRICT,
  ADD CONSTRAINT opening_balance_items_custody_id_company_id_fkey
  FOREIGN KEY (custody_id, company_id)
    REFERENCES custody_advances(id, company_id) ON DELETE RESTRICT;

CREATE INDEX opening_balance_items_obligation_idx
  ON opening_balance_items(company_id, obligation_id)
  WHERE obligation_id IS NOT NULL;

CREATE INDEX opening_balance_items_custody_idx
  ON opening_balance_items(company_id, custody_id)
  WHERE custody_id IS NOT NULL;
