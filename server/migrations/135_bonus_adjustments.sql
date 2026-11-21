ALTER TABLE employee_bonus_balance_entries ADD COLUMN adjustment_reason text
  CHECK (adjustment_reason IS NULL OR length(btrim(adjustment_reason)) BETWEEN 1 AND 1000);
