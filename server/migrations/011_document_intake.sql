-- Migration 011: nullable manager document intake metadata
ALTER TABLE documents
  ADD COLUMN document_type TEXT CHECK (document_type IS NULL OR document_type IN ('purchase', 'expense', 'sale', 'other')),
  ADD COLUMN counterparty_name TEXT CHECK (counterparty_name IS NULL OR char_length(counterparty_name) <= 200),
  ADD COLUMN document_date DATE,
  ADD COLUMN reference_number TEXT CHECK (reference_number IS NULL OR char_length(reference_number) <= 100),
  ADD COLUMN total_amount NUMERIC(18,2) CHECK (total_amount IS NULL OR total_amount > 0),
  ADD COLUMN intake_note TEXT CHECK (intake_note IS NULL OR char_length(intake_note) <= 500);
