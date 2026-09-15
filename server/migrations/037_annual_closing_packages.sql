-- Phase 7B: durable annual closing packages and immutable snapshots.
INSERT INTO capabilities (id) VALUES
  ('annual_close.package.view'), ('annual_close.package.manage'),
  ('annual_close.package.finalize'), ('annual_close.package.handoff')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_capabilities (role_id, capability_id)
SELECT r.id, c.id FROM roles r CROSS JOIN (VALUES
  ('annual_close.package.view'), ('annual_close.package.manage'),
  ('annual_close.package.finalize'), ('annual_close.package.handoff')
) c(id) WHERE LOWER(BTRIM(r.name))='admin'
ON CONFLICT (role_id, capability_id) DO NOTHING;

CREATE TABLE annual_closing_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized','handed_off')),
  final_snapshot_id UUID,
  finalized_by_user_id UUID REFERENCES users(id), finalized_at TIMESTAMPTZ,
  handed_off_by_user_id UUID REFERENCES users(id), handed_off_at TIMESTAMPTZ,
  handoff_note TEXT, handoff_reference TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id,fiscal_year_id), UNIQUE (id,company_id),
  FOREIGN KEY (fiscal_year_id,company_id) REFERENCES fiscal_years(id,company_id) ON DELETE CASCADE
);

CREATE TABLE annual_closing_package_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  package_id UUID NOT NULL,
  fiscal_year_id UUID NOT NULL,
  snapshot_no INTEGER NOT NULL CHECK (snapshot_no > 0),
  snapshot_type TEXT NOT NULL CHECK (snapshot_type IN ('preview','final')),
  manifest JSONB NOT NULL, readiness JSONB NOT NULL, source_fingerprint TEXT NOT NULL,
  created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (package_id,snapshot_no), UNIQUE (id,company_id),
  FOREIGN KEY (package_id,company_id) REFERENCES annual_closing_packages(id,company_id) ON DELETE CASCADE,
  FOREIGN KEY (fiscal_year_id,company_id) REFERENCES fiscal_years(id,company_id) ON DELETE CASCADE
);

-- Multiple previews are allowed; there can only ever be one final snapshot.
CREATE UNIQUE INDEX annual_closing_package_one_final_idx ON annual_closing_package_snapshots(package_id) WHERE snapshot_type='final';
ALTER TABLE annual_closing_packages ADD CONSTRAINT annual_closing_packages_final_snapshot_fk
  FOREIGN KEY (final_snapshot_id,company_id) REFERENCES annual_closing_package_snapshots(id,company_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION reject_annual_closing_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'annual closing package snapshots are immutable'; END $$;
CREATE TRIGGER annual_closing_snapshot_immutable BEFORE UPDATE ON annual_closing_package_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_annual_closing_snapshot_mutation();
