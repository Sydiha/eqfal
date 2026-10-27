-- Migration 099: optional government payment details on direct obligation settlements (D1 / G5).
-- Descriptive metadata only: no amounts, accounts, journals or reconciliation behaviour change.
-- 098 is intentionally skipped (reserved, unauthorized); migrations are applied in filename order.
ALTER TABLE obligation_settlements
  ADD COLUMN payment_reference TEXT,
  ADD COLUMN period_from DATE,
  ADD COLUMN period_to DATE,
  ADD CONSTRAINT obligation_settlements_payment_reference_chk
    CHECK (payment_reference IS NULL OR (payment_reference = btrim(payment_reference) AND char_length(payment_reference) BETWEEN 1 AND 100)),
  ADD CONSTRAINT obligation_settlements_period_chk
    CHECK ((period_from IS NULL) = (period_to IS NULL) AND (period_from IS NULL OR period_to >= period_from));
