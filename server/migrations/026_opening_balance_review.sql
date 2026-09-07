-- Phase 1C: Opening Balance Review Foundation
INSERT INTO capabilities (id) VALUES
  ('opening_balance.view'),
  ('opening_balance.manage'),
  ('opening_balance.review'),
  ('opening_balance.approve')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE opening_balance_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_review','approved')),
  journal_entry_id UUID,
  prepared_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  review_note TEXT CHECK(review_note IS NULL OR char_length(review_note)<=1000),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(id,company_id),
  UNIQUE(company_id,fiscal_year_id),
  UNIQUE(company_id,journal_entry_id),
  FOREIGN KEY(fiscal_year_id,company_id) REFERENCES fiscal_years(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(journal_entry_id,company_id) REFERENCES journal_entries(id,company_id) ON DELETE RESTRICT,
  CHECK(
    (status='draft' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status='in_review' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND approved_by IS NULL AND approved_at IS NULL)
    OR (status='approved' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND journal_entry_id IS NOT NULL)
  )
);
CREATE INDEX opening_balance_reviews_company_idx ON opening_balance_reviews(company_id,status,fiscal_year_id);

CREATE TABLE opening_balance_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id UUID NOT NULL,
  category TEXT NOT NULL CHECK(category IN (
    'bank','receivable','payable','partner_capital','partner_current','partner_loan',
    'custody_advance','vat_tax','fixed_asset_cost','accumulated_depreciation',
    'other_asset','other_liability','equity'
  )),
  account_id UUID NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK(amount>0),
  balance_side TEXT NOT NULL CHECK(balance_side IN ('debit','credit')),
  counterparty_id UUID,
  partner_id UUID,
  bank_account_id UUID,
  asset_id UUID,
  source_type TEXT NOT NULL CHECK(source_type IN (
    'bank_statement','customer_statement','supplier_statement','official_filing','original_document',
    'internal_ledger','management_reconciliation','manual_unverified','system_suggestion'
  )),
  source_document_id UUID,
  source_reference TEXT CHECK(source_reference IS NULL OR char_length(source_reference)<=500),
  confidence TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
  note TEXT CHECK(note IS NULL OR char_length(note)<=1000),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  UNIQUE(id,company_id),
  FOREIGN KEY(review_id,company_id) REFERENCES opening_balance_reviews(id,company_id) ON DELETE CASCADE,
  FOREIGN KEY(account_id,company_id) REFERENCES accounts(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(counterparty_id,company_id) REFERENCES counterparties(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(partner_id,company_id) REFERENCES partners(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(bank_account_id,company_id) REFERENCES bank_accounts(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(asset_id,company_id) REFERENCES fixed_assets(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(source_document_id,company_id) REFERENCES documents(id,company_id) ON DELETE RESTRICT
);
CREATE INDEX opening_balance_items_review_idx ON opening_balance_items(company_id,review_id,category,created_at,id);

CREATE FUNCTION protect_approved_opening_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='approved' THEN
    RAISE EXCEPTION 'approved opening balance review is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opening_balance_reviews_approved_immutable BEFORE UPDATE OR DELETE ON opening_balance_reviews
  FOR EACH ROW EXECUTE FUNCTION protect_approved_opening_balance();

CREATE FUNCTION protect_opening_balance_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_status TEXT;
BEGIN
  SELECT status INTO review_status FROM opening_balance_reviews
  WHERE id=COALESCE(NEW.review_id,OLD.review_id) AND company_id=COALESCE(NEW.company_id,OLD.company_id);
  IF review_status<>'draft' THEN
    RAISE EXCEPTION 'opening balance items are editable only in draft' USING ERRCODE='55000';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER opening_balance_items_draft_only BEFORE INSERT OR UPDATE OR DELETE ON opening_balance_items
  FOR EACH ROW EXECUTE FUNCTION protect_opening_balance_items();
