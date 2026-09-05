-- Fixed Assets Foundation V1: tenant-scoped register, depreciation and disposal.
INSERT INTO capabilities (id) VALUES
  ('asset.view'),('asset.manage'),('asset.approve'),('asset.dispose')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE asset_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code IN ('land','buildings','vehicles','machinery_equipment','furniture_fixtures','computers_it','leasehold_improvements','other_fixed_assets')),
  name_ar TEXT NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 200),
  name_en TEXT NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 200),
  depreciable BOOLEAN NOT NULL DEFAULT TRUE,
  default_useful_life_months INTEGER CHECK (default_useful_life_months IS NULL OR default_useful_life_months > 0),
  default_depreciation_method TEXT NOT NULL DEFAULT 'straight_line' CHECK (default_depreciation_method='straight_line'),
  asset_account_id UUID,
  accumulated_depreciation_account_id UUID,
  depreciation_expense_account_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(id,company_id), UNIQUE(company_id,code),
  FOREIGN KEY(asset_account_id,company_id) REFERENCES accounts(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(accumulated_depreciation_account_id,company_id) REFERENCES accounts(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(depreciation_expense_account_id,company_id) REFERENCES accounts(id,company_id) ON DELETE RESTRICT
);

CREATE FUNCTION seed_asset_categories(target UUID) RETURNS void LANGUAGE sql AS $$
  INSERT INTO asset_categories(company_id,code,name_ar,name_en,depreciable) VALUES
  (target,'land','الأراضي','Land',FALSE),(target,'buildings','المباني','Buildings',TRUE),
  (target,'vehicles','المركبات','Vehicles',TRUE),(target,'machinery_equipment','الآلات والمعدات','Machinery & Equipment',TRUE),
  (target,'furniture_fixtures','الأثاث والتجهيزات','Furniture & Fixtures',TRUE),(target,'computers_it','الحاسب وتقنية المعلومات','Computers & IT',TRUE),
  (target,'leasehold_improvements','تحسينات العقارات المستأجرة','Leasehold Improvements',TRUE),(target,'other_fixed_assets','أصول ثابتة أخرى','Other Fixed Assets',TRUE)
  ON CONFLICT(company_id,code) DO NOTHING
$$;
SELECT seed_asset_categories(id) FROM companies;
CREATE FUNCTION seed_asset_categories_for_company() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM seed_asset_categories(NEW.id); RETURN NEW; END $$;
CREATE TRIGGER company_asset_categories AFTER INSERT ON companies FOR EACH ROW EXECUTE FUNCTION seed_asset_categories_for_company();

CREATE SEQUENCE fixed_asset_number_seq;
CREATE TABLE fixed_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_category_id UUID NOT NULL, asset_number TEXT NOT NULL DEFAULT ('FA-'||lpad(nextval('fixed_asset_number_seq')::text,8,'0')),
  name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 300), description TEXT,
  source_type TEXT NOT NULL CHECK(source_type IN ('document','manual_opening')), source_document_id UUID, source_reference TEXT, manual_reason TEXT,
  acquisition_cost NUMERIC(18,2) NOT NULL CHECK(acquisition_cost>0), acquisition_date DATE NOT NULL, placed_in_service_date DATE NOT NULL,
  depreciation_start_date DATE, useful_life_months INTEGER, residual_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  opening_accumulated_depreciation NUMERIC(18,2) NOT NULL DEFAULT 0, depreciation_method TEXT NOT NULL DEFAULT 'straight_line' CHECK(depreciation_method='straight_line'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','fully_depreciated','disposed','cancelled')),
  approved_by UUID, approved_at TIMESTAMPTZ, disposed_at TIMESTAMPTZ, created_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(id,company_id), UNIQUE(company_id,asset_number),
  FOREIGN KEY(asset_category_id,company_id) REFERENCES asset_categories(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(source_document_id,company_id) REFERENCES documents(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT, FOREIGN KEY(approved_by) REFERENCES users(id) ON DELETE RESTRICT,
  CHECK(residual_value>=0 AND residual_value<=acquisition_cost),
  CHECK(opening_accumulated_depreciation>=0 AND opening_accumulated_depreciation<=acquisition_cost-residual_value),
  CHECK((source_type='document' AND source_document_id IS NOT NULL AND manual_reason IS NULL) OR (source_type='manual_opening' AND source_document_id IS NULL AND length(btrim(manual_reason))>0 AND length(btrim(source_reference))>0)),
  CHECK(useful_life_months IS NULL OR useful_life_months>0)
);
CREATE UNIQUE INDEX fixed_assets_full_document_uidx ON fixed_assets(company_id,source_document_id) WHERE source_type='document' AND status<>'cancelled';
CREATE INDEX fixed_assets_company_status_idx ON fixed_assets(company_id,status);

CREATE TABLE asset_depreciation_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE, asset_id UUID NOT NULL,
  period_start DATE NOT NULL, period_end DATE NOT NULL, opening_nbv NUMERIC(18,2) NOT NULL, depreciation_amount NUMERIC(18,2) NOT NULL CHECK(depreciation_amount>=0),
  accumulated_depreciation NUMERIC(18,2) NOT NULL, closing_nbv NUMERIC(18,2) NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','posted')),
  journal_entry_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(id,company_id), UNIQUE(company_id,asset_id,period_start),
  FOREIGN KEY(asset_id,company_id) REFERENCES fixed_assets(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(journal_entry_id,company_id) REFERENCES journal_entries(id,company_id) ON DELETE RESTRICT,
  CHECK(period_end>=period_start), CHECK(closing_nbv>=0)
);
CREATE INDEX asset_depreciation_company_period_idx ON asset_depreciation_entries(company_id,period_start,period_end,status);

CREATE TABLE asset_disposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE, asset_id UUID NOT NULL,
  disposal_type TEXT NOT NULL CHECK(disposal_type IN ('sale','scrap_write_off','other')), disposal_date DATE NOT NULL,
  disposal_proceeds NUMERIC(18,2) NOT NULL CHECK(disposal_proceeds>=0), source_sale_document_id UUID, reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  nbv_at_disposal NUMERIC(18,2) NOT NULL, calculated_gain_loss NUMERIC(18,2) NOT NULL, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(id,company_id), UNIQUE(company_id,asset_id),
  FOREIGN KEY(asset_id,company_id) REFERENCES fixed_assets(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(source_sale_document_id,company_id) REFERENCES documents(id,company_id) ON DELETE RESTRICT
);

CREATE TRIGGER posted_asset_depreciation_guard BEFORE UPDATE OF depreciation_amount,period_start,period_end,asset_id OR DELETE ON asset_depreciation_entries FOR EACH ROW EXECUTE FUNCTION guard_posted_operational_source('asset_depreciation');
CREATE TRIGGER posted_asset_disposal_guard BEFORE UPDATE OR DELETE ON asset_disposals FOR EACH ROW EXECUTE FUNCTION guard_posted_operational_source('asset_disposal');
