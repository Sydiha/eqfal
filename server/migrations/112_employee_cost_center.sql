-- ECC-01: company-scoped employee registry and manually recorded employee costs.
-- Capability identifiers are registered only. No role receives these permissions by default.

INSERT INTO capabilities (id) VALUES
  ('employee.view'),
  ('employee.manage'),
  ('employee_cost.view'),
  ('employee_cost.salary.view'),
  ('employee_cost.create'),
  ('employee_cost.approve'),
  ('employee_cost.correct')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_number TEXT NOT NULL CHECK (char_length(btrim(employee_number)) BETWEEN 1 AND 50),
  display_name TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
  employment_start DATE,
  employment_end DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, employee_number),
  CHECK (employment_end IS NULL OR employment_start IS NOT NULL AND employment_end >= employment_start)
);
CREATE INDEX employees_company_list_idx ON employees (company_id, is_active DESC, employee_number);

CREATE TABLE employee_cost_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'salary','allowances','bonus','overtime','employer_gosi','employee_deduction','residency','work_permit',
    'medical_insurance','travel_benefit','end_of_service','other'
  )),
  nature TEXT NOT NULL CHECK (nature IN ('earning','employer_cost','employee_deduction')),
  currency_code CHAR(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount > 0),
  service_period_start DATE NOT NULL,
  service_period_end DATE NOT NULL,
  description TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  supersedes_id UUID,
  correction_reason TEXT CHECK (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 1 AND 500),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  UNIQUE (id, company_id),
  FOREIGN KEY (employee_id, company_id) REFERENCES employees(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_id, company_id) REFERENCES employee_cost_records(id, company_id) ON DELETE RESTRICT,
  CHECK (service_period_end >= service_period_start),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK ((supersedes_id IS NULL AND correction_reason IS NULL) OR (supersedes_id IS NOT NULL AND correction_reason IS NOT NULL)),
  CHECK ((status = 'draft' AND approved_by IS NULL AND approved_at IS NULL) OR (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (
    (category = 'salary' AND nature = 'earning') OR
    (category IN ('allowances','bonus','overtime') AND nature = 'earning') OR
    (category = 'employee_deduction' AND nature = 'employee_deduction') OR
    (category IN ('employer_gosi','residency','work_permit','medical_insurance','travel_benefit','end_of_service','other') AND nature = 'employer_cost')
  )
);
CREATE INDEX employee_cost_records_company_employee_idx ON employee_cost_records (company_id, employee_id, service_period_start);
CREATE INDEX employee_cost_records_successor_idx ON employee_cost_records (company_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE UNIQUE INDEX employee_cost_records_one_correction_idx ON employee_cost_records (company_id, supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TABLE employee_cost_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cost_record_id UUID NOT NULL,
  fiscal_year_id UUID NOT NULL,
  allocation_month DATE NOT NULL CHECK (EXTRACT(DAY FROM allocation_month) = 1),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (company_id, cost_record_id, allocation_month),
  FOREIGN KEY (cost_record_id, company_id) REFERENCES employee_cost_records(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (fiscal_year_id, company_id) REFERENCES fiscal_years(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX employee_cost_allocations_report_idx ON employee_cost_allocations (company_id, fiscal_year_id, allocation_month, cost_record_id);

-- Approved rows and their allocations are immutable. Corrections create a new record instead.
CREATE FUNCTION employee_cost_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocated NUMERIC; predecessor RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'Approved employee cost records cannot be deleted' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'Employee cost records must start as drafts' USING ERRCODE='23514'; END IF;
    IF NEW.supersedes_id IS NOT NULL THEN
      SELECT * INTO predecessor FROM employee_cost_records WHERE id=NEW.supersedes_id AND company_id=NEW.company_id FOR UPDATE;
      IF NOT FOUND OR predecessor.status <> 'approved' OR predecessor.employee_id <> NEW.employee_id THEN
        RAISE EXCEPTION 'A correction must reference an approved cost for the same employee' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.company_id,NEW.employee_id,NEW.created_by,NEW.created_at,NEW.supersedes_id,NEW.correction_reason)
     IS DISTINCT FROM (OLD.id,OLD.company_id,OLD.employee_id,OLD.created_by,OLD.created_at,OLD.supersedes_id,OLD.correction_reason) THEN
    RAISE EXCEPTION 'Employee cost record identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status = 'approved' THEN RAISE EXCEPTION 'Approved employee cost records are immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status <> 'draft' OR NEW.status NOT IN ('draft','approved') THEN
    RAISE EXCEPTION 'Invalid employee cost record transition' USING ERRCODE='55000';
  END IF;
  IF NEW.status = 'approved' THEN
    SELECT COALESCE(SUM(amount),0) INTO allocated FROM employee_cost_allocations WHERE cost_record_id=OLD.id AND company_id=OLD.company_id;
    IF allocated <> NEW.total_amount THEN RAISE EXCEPTION 'Employee cost allocations must equal the record total' USING ERRCODE='23514'; END IF;
    IF NEW.supersedes_id IS NOT NULL THEN
      SELECT * INTO predecessor FROM employee_cost_records WHERE id=NEW.supersedes_id AND company_id=NEW.company_id FOR UPDATE;
      IF NOT FOUND OR predecessor.status <> 'approved' OR predecessor.employee_id <> NEW.employee_id THEN
        RAISE EXCEPTION 'A correction must reference an approved cost for the same employee' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_cost_record_guard BEFORE INSERT OR UPDATE OR DELETE ON employee_cost_records
FOR EACH ROW EXECUTE FUNCTION employee_cost_record_guard();

CREATE FUNCTION employee_cost_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE record_id UUID; company UUID; cost_row RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN record_id := OLD.cost_record_id; company := OLD.company_id;
  ELSE record_id := NEW.cost_record_id; company := NEW.company_id; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id,NEW.company_id,NEW.cost_record_id) IS DISTINCT FROM (OLD.id,OLD.company_id,OLD.cost_record_id) THEN
    RAISE EXCEPTION 'Employee cost allocation identity is immutable' USING ERRCODE='55000';
  END IF;
  SELECT status,service_period_start,service_period_end INTO cost_row FROM employee_cost_records WHERE id=record_id AND company_id=company FOR UPDATE;
  IF cost_row.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Allocations can only change while the cost record is a draft' USING ERRCODE='55000'; END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.allocation_month < date_trunc('month',cost_row.service_period_start)::date OR NEW.allocation_month > date_trunc('month',cost_row.service_period_end)::date THEN
      RAISE EXCEPTION 'Allocation month is outside the service period' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM fiscal_years fy WHERE fy.id=NEW.fiscal_year_id AND fy.company_id=NEW.company_id
      AND fy.start_date <= (NEW.allocation_month + INTERVAL '1 month - 1 day')::date AND fy.end_date >= NEW.allocation_month) THEN
      RAISE EXCEPTION 'Allocation month does not overlap the selected fiscal year' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_cost_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON employee_cost_allocations
FOR EACH ROW EXECUTE FUNCTION employee_cost_allocation_guard();
