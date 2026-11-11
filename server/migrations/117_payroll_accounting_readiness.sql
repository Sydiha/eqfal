-- PAYROLL-02: explicit mappings and preview-only payroll accounting readiness.
-- No role grants, historical records, or journal rows are changed.
INSERT INTO capabilities(id, implicit_full_access) VALUES
  ('payroll.accounting.mapping.view', FALSE),
  ('payroll.accounting.mapping.manage', FALSE),
  ('payroll.accounting.preview', FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access = FALSE;

CREATE TABLE payroll_account_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mapping_key TEXT NOT NULL CHECK (mapping_key IN (
    'earnings_expense', 'employer_contribution_expense', 'net_payroll_liability',
    'employee_deduction_liability', 'employer_contribution_liability'
  )),
  account_id UUID NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, mapping_key),
  FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX payroll_account_mappings_account_idx ON payroll_account_mappings(company_id, account_id);
