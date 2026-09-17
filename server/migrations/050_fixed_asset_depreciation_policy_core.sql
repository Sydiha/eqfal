-- Phase 2A.1: versioned fixed-asset category depreciation policy core.

CREATE TABLE asset_category_depreciation_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_category_id UUID NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  effective_from DATE,
  depreciation_method TEXT CHECK (depreciation_method IS NULL OR depreciation_method = 'straight_line'),
  useful_life_mode TEXT NOT NULL CHECK (useful_life_mode IN ('fixed','asset_specific','not_applicable')),
  useful_life_months INTEGER CHECK (useful_life_months IS NULL OR useful_life_months > 0),
  residual_value_policy TEXT NOT NULL CHECK (residual_value_policy IN ('zero','asset_specific','not_applicable')),
  depreciation_start_basis TEXT NOT NULL CHECK (depreciation_start_basis IN ('placed_in_service','explicit_date','not_applicable')),
  asset_account_id UUID,
  accumulated_depreciation_account_id UUID,
  depreciation_expense_account_id UUID,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
  is_legacy_migrated BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(id,company_id),
  UNIQUE(company_id,asset_category_id,version_number),
  UNIQUE(company_id,asset_category_id,effective_from),
  FOREIGN KEY(asset_category_id,company_id) REFERENCES asset_categories(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(asset_account_id,company_id) REFERENCES accounts(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(accumulated_depreciation_account_id,company_id) REFERENCES accounts(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY(depreciation_expense_account_id,company_id) REFERENCES accounts(id,company_id) ON DELETE RESTRICT,
  CHECK (
    (useful_life_mode='fixed' AND useful_life_months IS NOT NULL)
    OR (useful_life_mode<>'fixed' AND useful_life_months IS NULL)
  ),
  CHECK (
    (useful_life_mode='not_applicable' AND depreciation_method IS NULL AND residual_value_policy='not_applicable' AND depreciation_start_basis='not_applicable')
    OR (useful_life_mode<>'not_applicable' AND depreciation_method='straight_line' AND residual_value_policy<>'not_applicable' AND depreciation_start_basis<>'not_applicable')
  ),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (
    (is_legacy_migrated
      AND status='draft'
      AND effective_from IS NULL
      AND reviewed_by IS NULL AND reviewed_at IS NULL
      AND approved_by IS NULL AND approved_at IS NULL
      AND created_by IS NULL)
    OR
    (NOT is_legacy_migrated
      AND effective_from IS NOT NULL
      AND created_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX asset_category_one_approved_policy_uidx
  ON asset_category_depreciation_policies(company_id,asset_category_id)
  WHERE status='approved';

CREATE INDEX asset_category_policy_effective_idx
  ON asset_category_depreciation_policies(company_id,asset_category_id,effective_from DESC);

ALTER TABLE fixed_assets
  ADD COLUMN depreciation_policy_version_id UUID,
  ADD CONSTRAINT fixed_assets_policy_company_fk
    FOREIGN KEY(depreciation_policy_version_id,company_id)
    REFERENCES asset_category_depreciation_policies(id,company_id)
    ON DELETE RESTRICT;

-- Preserve the accounting mappings that existed at migration time for already
-- approved/disposed assets, but do not fabricate a historical effective date,
-- reviewer, approver or creator. These rows are immutable migrated snapshots,
-- not approved accounting policies and are never eligible for new approvals.
INSERT INTO asset_category_depreciation_policies(
  company_id,asset_category_id,version_number,effective_from,depreciation_method,
  useful_life_mode,useful_life_months,residual_value_policy,depreciation_start_basis,
  asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,
  status,is_legacy_migrated
)
SELECT
  c.company_id,c.id,1,NULL,
  CASE WHEN c.depreciable THEN c.default_depreciation_method ELSE NULL END,
  CASE WHEN NOT c.depreciable THEN 'not_applicable'
       WHEN c.default_useful_life_months IS NULL THEN 'asset_specific'
       ELSE 'fixed' END,
  CASE WHEN c.depreciable THEN c.default_useful_life_months ELSE NULL END,
  CASE WHEN c.depreciable THEN 'asset_specific' ELSE 'not_applicable' END,
  CASE WHEN c.depreciable THEN 'explicit_date' ELSE 'not_applicable' END,
  c.asset_account_id,c.accumulated_depreciation_account_id,c.depreciation_expense_account_id,
  'draft',TRUE
FROM asset_categories c
ON CONFLICT(company_id,asset_category_id,version_number) DO NOTHING;

-- Link only historical assets to the migrated snapshot. This preserves their
-- existing accounting mapping without implying that the snapshot was reviewed
-- or approved historically and without regenerating any depreciation schedule.
UPDATE fixed_assets a
SET depreciation_policy_version_id=p.id
FROM asset_category_depreciation_policies p
WHERE p.company_id=a.company_id
  AND p.asset_category_id=a.asset_category_id
  AND p.version_number=1
  AND p.is_legacy_migrated
  AND a.status IN ('active','fully_depreciated','disposed')
  AND a.depreciation_policy_version_id IS NULL;

CREATE OR REPLACE FUNCTION guard_asset_category_policy_columns()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('eqfal.asset_policy_sync',true) IS DISTINCT FROM 'on'
     AND (
       NEW.default_useful_life_months IS DISTINCT FROM OLD.default_useful_life_months
       OR NEW.default_depreciation_method IS DISTINCT FROM OLD.default_depreciation_method
       OR NEW.asset_account_id IS DISTINCT FROM OLD.asset_account_id
       OR NEW.accumulated_depreciation_account_id IS DISTINCT FROM OLD.accumulated_depreciation_account_id
       OR NEW.depreciation_expense_account_id IS DISTINCT FROM OLD.depreciation_expense_account_id
     )
  THEN
    RAISE EXCEPTION 'Depreciation policy fields must be changed through versioned policy workflow'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER asset_category_policy_columns_guard
BEFORE UPDATE OF default_useful_life_months,default_depreciation_method,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id
ON asset_categories
FOR EACH ROW EXECUTE FUNCTION guard_asset_category_policy_columns();

CREATE OR REPLACE FUNCTION bind_fixed_asset_policy_on_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  category_row asset_categories%ROWTYPE;
  policy_row asset_category_depreciation_policies%ROWTYPE;
  policy_date DATE;
BEGIN
  IF OLD.status='draft' AND NEW.status IN ('active','fully_depreciated') THEN
    SELECT * INTO category_row
    FROM asset_categories
    WHERE id=NEW.asset_category_id AND company_id=NEW.company_id;

    policy_date := COALESCE(NEW.depreciation_start_date,NEW.placed_in_service_date);

    SELECT * INTO policy_row
    FROM asset_category_depreciation_policies
    WHERE company_id=NEW.company_id
      AND asset_category_id=NEW.asset_category_id
      AND NOT is_legacy_migrated
      AND status IN ('approved','superseded')
      AND effective_from<=policy_date
    ORDER BY effective_from DESC,version_number DESC
    LIMIT 1;

    IF policy_row.id IS NULL THEN
      RAISE EXCEPTION 'No effective approved depreciation policy exists for asset category'
        USING ERRCODE='23514';
    END IF;

    IF category_row.depreciable THEN
      IF policy_row.depreciation_method IS DISTINCT FROM NEW.depreciation_method THEN
        RAISE EXCEPTION 'Asset depreciation method conflicts with effective category policy' USING ERRCODE='23514';
      END IF;
      IF policy_row.useful_life_mode='fixed' AND NEW.useful_life_months IS DISTINCT FROM policy_row.useful_life_months THEN
        RAISE EXCEPTION 'Asset useful life conflicts with effective category policy' USING ERRCODE='23514';
      END IF;
      IF policy_row.residual_value_policy='zero' AND NEW.residual_value<>0 THEN
        RAISE EXCEPTION 'Asset residual value conflicts with effective category policy' USING ERRCODE='23514';
      END IF;
      IF policy_row.depreciation_start_basis='placed_in_service' AND NEW.depreciation_start_date IS DISTINCT FROM NEW.placed_in_service_date THEN
        RAISE EXCEPTION 'Asset depreciation start conflicts with effective category policy' USING ERRCODE='23514';
      END IF;
      IF policy_row.asset_account_id IS NULL OR policy_row.accumulated_depreciation_account_id IS NULL OR policy_row.depreciation_expense_account_id IS NULL THEN
        RAISE EXCEPTION 'Effective depreciation policy accounting is incomplete' USING ERRCODE='23514';
      END IF;
    ELSE
      IF policy_row.useful_life_mode<>'not_applicable'
         OR NEW.useful_life_months IS NOT NULL
         OR NEW.depreciation_start_date IS NOT NULL
         OR NEW.opening_accumulated_depreciation<>0
      THEN
        RAISE EXCEPTION 'Non-depreciable asset conflicts with effective category policy' USING ERRCODE='23514';
      END IF;
    END IF;

    NEW.depreciation_policy_version_id := policy_row.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fixed_asset_policy_binding_guard
BEFORE UPDATE OF status ON fixed_assets
FOR EACH ROW EXECUTE FUNCTION bind_fixed_asset_policy_on_approval();
