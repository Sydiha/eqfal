-- Phase 2A.2: governed prospective fixed-asset estimate changes.

INSERT INTO capabilities (id)
VALUES
  ('asset.estimate_change.create'),
  ('asset.estimate_change.review'),
  ('asset.estimate_change.approve')
ON CONFLICT (id) DO NOTHING;

-- Preserve existing authority conservatively: editors may prepare estimate changes,
-- approvers may review and approve them.
INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, 'asset.estimate_change.create'
FROM role_capabilities rc
WHERE rc.capability_id='asset.edit'
ON CONFLICT (role_id, capability_id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (VALUES ('asset.estimate_change.review'),('asset.estimate_change.approve')) AS granular(id)
WHERE rc.capability_id='asset.approve'
ON CONFLICT (role_id, capability_id) DO NOTHING;

CREATE TABLE asset_estimate_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL,
  effective_from DATE NOT NULL,
  old_useful_life_months INTEGER,
  new_remaining_useful_life_months INTEGER,
  old_residual_value NUMERIC(18,2) NOT NULL,
  new_residual_value NUMERIC(18,2),
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
  policy_exception BOOLEAN NOT NULL DEFAULT FALSE,
  policy_exception_reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','reviewed','approved')),
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(id,company_id),
  FOREIGN KEY(asset_id,company_id) REFERENCES fixed_assets(id,company_id) ON DELETE RESTRICT,
  CHECK(EXTRACT(DAY FROM effective_from)=1),
  CHECK(new_remaining_useful_life_months IS NULL OR new_remaining_useful_life_months>0),
  CHECK(new_residual_value IS NULL OR new_residual_value>=0),
  CHECK(new_remaining_useful_life_months IS NOT NULL OR new_residual_value IS NOT NULL),
  CHECK((reviewed_by IS NULL)=(reviewed_at IS NULL)),
  CHECK((approved_by IS NULL)=(approved_at IS NULL)),
  CHECK((NOT policy_exception AND policy_exception_reason IS NULL)
        OR (policy_exception AND length(btrim(policy_exception_reason))>0))
);

CREATE UNIQUE INDEX asset_estimate_change_open_uidx
  ON asset_estimate_changes(company_id,asset_id)
  WHERE status IN ('draft','reviewed');

CREATE UNIQUE INDEX asset_estimate_change_approved_effective_uidx
  ON asset_estimate_changes(company_id,asset_id,effective_from)
  WHERE status='approved';

CREATE INDEX asset_estimate_change_asset_idx
  ON asset_estimate_changes(company_id,asset_id,effective_from DESC);

-- Approved assets are immutable outside the governed estimate-change workflow.
CREATE OR REPLACE FUNCTION guard_fixed_asset_estimate_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'draft'
     AND current_setting('eqfal.asset_estimate_change',true) IS DISTINCT FROM 'on'
     AND (
       NEW.useful_life_months IS DISTINCT FROM OLD.useful_life_months
       OR NEW.residual_value IS DISTINCT FROM OLD.residual_value
     )
  THEN
    RAISE EXCEPTION 'Approved fixed-asset estimates must be changed through governed estimate-change workflow'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fixed_asset_estimate_fields_guard
BEFORE UPDATE OF useful_life_months,residual_value ON fixed_assets
FOR EACH ROW EXECUTE FUNCTION guard_fixed_asset_estimate_fields();
