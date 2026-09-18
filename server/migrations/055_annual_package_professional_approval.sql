-- Phase 7D: internal professional review and approval of annual closing packages.
INSERT INTO capabilities (id) VALUES
  ('annual_close.package.review'), ('annual_close.package.approve')
ON CONFLICT (id) DO NOTHING;

-- Preserve the authority of roles that already held the package's legacy broad authority.
INSERT INTO role_capabilities (role_id, capability_id)
SELECT rc.role_id, granular.id
FROM role_capabilities rc
CROSS JOIN (VALUES ('annual_close.package.review'), ('annual_close.package.approve')) granular(id)
WHERE rc.capability_id = 'annual_close.package.manage'
ON CONFLICT (role_id, capability_id) DO NOTHING;

ALTER TABLE annual_closing_packages DROP CONSTRAINT annual_closing_packages_status_check;
ALTER TABLE annual_closing_packages
  ADD CONSTRAINT annual_closing_packages_status_check
    CHECK (status IN ('draft','finalized','handed_off','reviewed','approved')),
  ADD COLUMN reviewed_by_user_id UUID REFERENCES users(id),
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  ADD COLUMN review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  ADD COLUMN approved_by_user_id UUID REFERENCES users(id),
  ADD COLUMN approved_at TIMESTAMPTZ,
  ADD COLUMN approval_note TEXT CHECK (approval_note IS NULL OR char_length(approval_note) <= 2000),
  ADD CONSTRAINT annual_closing_package_review_metadata CHECK (
    (reviewed_by_user_id IS NULL) = (reviewed_at IS NULL)
    AND (status NOT IN ('reviewed','approved') OR reviewed_by_user_id IS NOT NULL)
  ),
  ADD CONSTRAINT annual_closing_package_approval_metadata CHECK (
    (approved_by_user_id IS NULL) = (approved_at IS NULL)
    AND (status <> 'approved' OR approved_by_user_id IS NOT NULL)
  );
