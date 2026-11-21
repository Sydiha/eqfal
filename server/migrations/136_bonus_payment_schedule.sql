CREATE TABLE employee_bonus_payment_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  entitlement_id uuid NOT NULL,
  request_key uuid NOT NULL,
  due_on date NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  channel text NOT NULL CHECK (channel IN ('payroll','bank')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, entitlement_id, request_key),
  FOREIGN KEY (entitlement_id, company_id) REFERENCES employee_bonus_entitlements(id, company_id)
);
