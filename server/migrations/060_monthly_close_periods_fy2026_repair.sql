-- Migration 060: repair two missing monthly close periods in FY 2026.
--
-- FY 2026 (dcbdd629-6d8d-4ce7-82ab-7192dd3e74dc) of company
-- 0e8574b6-5828-40c6-9b56-7dbd1c7e9def is closed but has no monthly_close_periods
-- rows for October and December 2026. This inserts ONLY those two rows, as 'open'.
--
-- * No existing period row is updated (Jan, Feb-Aug, Sep, Nov keep their status).
-- * fiscal_years is not touched (FY 2026 stays 'closed').
-- * Idempotent: conflict target is the real unique constraint
--   UNIQUE (company_id, period_start, period_end) from migration 019.
-- * Safe on databases where this fiscal year does not exist: rows are selected
--   from fiscal_years, so nothing is inserted (and no FK error is raised).
-- * Runs as a single statement, therefore atomically.

INSERT INTO monthly_close_periods (company_id, fiscal_year_id, period_start, period_end, status)
SELECT fy.company_id, fy.id, p.period_start, p.period_end, 'open'
FROM fiscal_years fy
CROSS JOIN (VALUES
  (DATE '2026-10-01', DATE '2026-10-31'),
  (DATE '2026-12-01', DATE '2026-12-31')
) AS p(period_start, period_end)
WHERE fy.id = 'dcbdd629-6d8d-4ce7-82ab-7192dd3e74dc'::uuid
  AND fy.company_id = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid
ON CONFLICT (company_id, period_start, period_end) DO NOTHING;
