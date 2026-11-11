-- Approval is an explicit company-role grant, including for Full Access and system administrators.
ALTER TABLE capabilities DROP CONSTRAINT capabilities_full_access_wildcard;
INSERT INTO capabilities(id, implicit_full_access) VALUES ('payroll.approve', FALSE)
ON CONFLICT (id) DO UPDATE SET implicit_full_access = FALSE;
CREATE TABLE payroll_draft_contributors (
  company_id UUID NOT NULL, draft_id UUID NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  PRIMARY KEY (company_id, draft_id, user_id),
  FOREIGN KEY (draft_id, company_id) REFERENCES payroll_drafts(id, company_id) ON DELETE CASCADE
);
ALTER TABLE payroll_drafts
  ADD COLUMN status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  ADD COLUMN approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN approved_at TIMESTAMPTZ,
  ADD CONSTRAINT payroll_approval_fields_check CHECK
    ((status = 'draft' AND approved_by IS NULL AND approved_at IS NULL) OR
     (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL));
INSERT INTO payroll_draft_contributors(company_id, draft_id, user_id)
SELECT company_id, id, created_by FROM payroll_drafts ON CONFLICT DO NOTHING;
INSERT INTO payroll_draft_contributors(company_id, draft_id, user_id)
SELECT DISTINCT d.company_id, d.id, a.actor_user_id
FROM payroll_drafts d JOIN audit_log a ON a.company_id = d.company_id
  AND a.action IN ('payroll.draft_employee.create', 'payroll.draft_employee.update')
  AND a.after_data->>'draft_id' = d.id::text
ON CONFLICT DO NOTHING;
