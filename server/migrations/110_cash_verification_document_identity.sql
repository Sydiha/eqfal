-- Add document identity to physical-cash reviewer decisions without changing historical migrations.
-- Existing decisions without a document identity are treated as stale by the application.
ALTER TABLE opening_balance_cash_verifications
  ADD COLUMN document_id uuid,
  ADD COLUMN document_sha256 text CHECK (document_sha256 IS NULL OR document_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN document_version integer CHECK (document_version IS NULL OR document_version > 0),
  ADD CONSTRAINT opening_balance_cash_verified_document_check CHECK (
    decision <> 'verified' OR
    (document_id IS NOT NULL AND document_sha256 IS NOT NULL AND document_version IS NOT NULL)
  ) NOT VALID;
