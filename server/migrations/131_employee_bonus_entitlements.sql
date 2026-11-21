-- New entitlements only. Historical payroll and employee costs are not converted.
CREATE TABLE employee_bonus_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  employee_id uuid NOT NULL,
  request_key uuid NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('monthly','quarterly','annual','one_time')),
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end >= period_start),
  eligibility_condition text NOT NULL CHECK (length(btrim(eligibility_condition)) > 0),
  recognition_condition text NOT NULL CHECK (length(btrim(recognition_condition)) > 0),
  calculation_method text NOT NULL CHECK (calculation_method IN ('fixed','basic_multiplier','total_multiplier','percentage')),
  percentage_basis text CHECK (percentage_basis IN ('basic','total')),
  calculation_value numeric(20,4) NOT NULL CHECK (calculation_value >= 0),
  basic_salary numeric(18,2) NOT NULL CHECK (basic_salary >= 0),
  applicable_allowances numeric(18,2) NOT NULL CHECK (applicable_allowances >= 0),
  amount numeric(18,2) GENERATED ALWAYS AS (round(
    CASE calculation_method
      WHEN 'fixed' THEN calculation_value
      WHEN 'basic_multiplier' THEN basic_salary * calculation_value
      WHEN 'total_multiplier' THEN (basic_salary + applicable_allowances) * calculation_value
      WHEN 'percentage' THEN (basic_salary + CASE WHEN percentage_basis = 'total' THEN applicable_allowances ELSE 0 END) * calculation_value / 100
    END, 2)) STORED,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  UNIQUE (id, company_id),
  UNIQUE (company_id, request_key, employee_id),
  FOREIGN KEY (employee_id, company_id) REFERENCES employees(id, company_id),
  CHECK ((percentage_basis IS NOT NULL) = (calculation_method = 'percentage')),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);

CREATE FUNCTION guard_approved_bonus_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'approved bonus entitlement is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF (NEW.id, NEW.company_id, NEW.employee_id, NEW.request_key, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.company_id, OLD.employee_id, OLD.request_key, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'bonus entitlement identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER approved_bonus_entitlement_guard
BEFORE UPDATE OR DELETE ON employee_bonus_entitlements
FOR EACH ROW EXECUTE FUNCTION guard_approved_bonus_entitlement();
