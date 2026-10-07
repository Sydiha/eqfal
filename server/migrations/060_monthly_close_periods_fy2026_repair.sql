-- Migration 060: Repair missing monthly close periods for FY 2026
--
-- Context:
-- Fiscal Year 2026 (dcbdd629-6d8d-4ce7-82ab-7192dd3e74dc) for test company
-- (0e8574b6-5828-40c6-9b56-7dbd1c7e9def) was manually created without
-- auto-provisioning of monthly periods. This migration adds the missing
-- October and December 2026 periods that were not present in the database.
--
-- Periods preserved as-is: Jan, Feb–Aug (implied), Sep, Nov
-- Periods added as open: Oct, Dec
-- Fiscal year status: remains 'closed' (not modified)
--
-- This migration is idempotent: safe to run multiple times with identical results.

INSERT INTO monthly_close_periods (
  company_id,
  fiscal_year_id,
  period_start,
  period_end,
  status,
  created_at,
  updated_at
) VALUES
  -- October 2026
  (
    '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid,
    'dcbdd629-6d8d-4ce7-82ab-7192dd3e74dc'::uuid,
    '2026-10-01'::date,
    '2026-10-31'::date,
    'open',
    NOW(),
    NOW()
  ),
  -- December 2026
  (
    '0e8574b6-5828-40c6-9b56-7dbd1c7e9def'::uuid,
    'dcbdd629-6d8d-4ce7-82ab-7192dd3e74dc'::uuid,
    '2026-12-01'::date,
    '2026-12-31'::date,
    'open',
    NOW(),
    NOW()
  )
ON CONFLICT (company_id, fiscal_year_id, period_start, period_end) DO NOTHING;
