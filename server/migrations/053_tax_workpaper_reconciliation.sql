-- Phase 7B: bind tax workpapers to the posted profit-or-loss source state.
ALTER TABLE tax_working_papers
  ADD COLUMN starting_financial_base NUMERIC(18,2),
  ADD COLUMN source_fingerprint TEXT,
  ADD COLUMN source_reconciled_at TIMESTAMPTZ;

ALTER TABLE tax_working_papers
  ADD CONSTRAINT tax_workpaper_reconciliation_evidence_complete CHECK (
    (starting_financial_base IS NULL AND source_fingerprint IS NULL AND source_reconciled_at IS NULL)
    OR
    (starting_financial_base IS NOT NULL AND source_fingerprint IS NOT NULL AND source_reconciled_at IS NOT NULL)
  );
