-- PAYROLL-01A: manual, company-scoped drafts only. No accounting or ECC side effects.
INSERT INTO capabilities(id) VALUES ('payroll.view'),('payroll.edit') ON CONFLICT DO NOTHING;
CREATE TABLE payroll_drafts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 period_month DATE NOT NULL CHECK (EXTRACT(DAY FROM period_month)=1), currency_code CHAR(3) NOT NULL DEFAULT 'SAR' CHECK(currency_code='SAR'),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(id,company_id), UNIQUE(company_id,period_month)
);
CREATE TABLE payroll_draft_employees (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL, draft_id UUID NOT NULL, employee_id UUID NOT NULL,
 salary NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(salary>=0), allowances NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(allowances>=0),
 bonus NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(bonus>=0), overtime NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(overtime>=0),
 deductions NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(deductions>=0), employer_contributions NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK(employer_contributions>=0),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(company_id,draft_id,employee_id), FOREIGN KEY(draft_id,company_id) REFERENCES payroll_drafts(id,company_id) ON DELETE CASCADE,
 FOREIGN KEY(employee_id,company_id) REFERENCES employees(id,company_id) ON DELETE RESTRICT,
 CHECK(salary+allowances+bonus+overtime>=deductions)
);
