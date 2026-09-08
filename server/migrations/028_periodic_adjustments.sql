-- Phase 4: accruals, prepayments and periodic adjustments foundation.

INSERT INTO capabilities (id)
VALUES
  ('periodic_adjustment.view'),
  ('periodic_adjustment.manage'),
  ('periodic_adjustment.review'),
  ('periodic_adjustment.approve'),
  ('periodic_adjustment.post')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE periodic_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN (
    'accrued_expense',
    'prepaid_expense',
    'accrued_income',
    'deferred_income'
  )),
  total_amount NUMERIC(18,2) NOT NULL CHECK (total_amount > 0),
  recognition_start DATE NOT NULL,
  recognition_end DATE NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency = 'monthly'),
  document_id UUID,
  obligation_id UUID,
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  reference TEXT CHECK (reference IS NULL OR length(reference) <= 200),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  balance_account_id UUID NOT NULL,
  pnl_account_id UUID NOT NULL,
  workflow_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (workflow_status IN ('draft','in_review','approved','completed')),
  prepared_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at TIMESTAMPTZ,
  approved_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  review_note TEXT CHECK (review_note IS NULL OR length(review_note) <= 1000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  FOREIGN KEY (document_id, company_id) REFERENCES documents(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (obligation_id, company_id) REFERENCES obligations(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (balance_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (pnl_account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  CHECK (recognition_end >= recognition_start),
  CHECK (balance_account_id <> pnl_account_id),
  CHECK (
    (workflow_status = 'draft' AND approved_by_user_id IS NULL AND approved_at IS NULL)
    OR (workflow_status = 'in_review' AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL AND approved_by_user_id IS NULL AND approved_at IS NULL)
    OR (workflow_status IN ('approved','completed') AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE INDEX periodic_adjustments_company_status_idx
  ON periodic_adjustments (company_id, workflow_status, recognition_start, recognition_end);
CREATE INDEX periodic_adjustments_document_idx
  ON periodic_adjustments (company_id, document_id) WHERE document_id IS NOT NULL;
CREATE INDEX periodic_adjustments_obligation_idx
  ON periodic_adjustments (company_id, obligation_id) WHERE obligation_id IS NOT NULL;

CREATE TABLE periodic_adjustment_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  adjustment_id UUID NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  recognition_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted')),
  journal_entry_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  UNIQUE (adjustment_id, period_start, period_end),
  FOREIGN KEY (adjustment_id, company_id) REFERENCES periodic_adjustments(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (journal_entry_id, company_id) REFERENCES journal_entries(id, company_id) ON DELETE RESTRICT,
  CHECK (period_end >= period_start),
  CHECK (recognition_date BETWEEN period_start AND period_end),
  CHECK ((status = 'pending' AND journal_entry_id IS NULL) OR (status = 'posted' AND journal_entry_id IS NOT NULL))
);

CREATE INDEX periodic_adjustment_schedule_due_idx
  ON periodic_adjustment_schedule (company_id, recognition_date, status);
CREATE UNIQUE INDEX periodic_adjustment_schedule_journal_uidx
  ON periodic_adjustment_schedule (company_id, journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;
