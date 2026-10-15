-- Migration 078 (Delete & Void Phase 2 follow-up): durable queue of stored files whose owning document row was deleted.
-- A row is written in the SAME transaction as the document delete, so a crash or storage outage after commit can never lose track of a file.
-- A background retry (the in-process scheduler pattern used by recurring invoices) removes the file and marks the row done; no manual SQL is needed.
-- Deliberately no foreign key to documents/companies rows: the document is already gone, and the row is the evidence of what to remove.
-- Rollback: DROP TABLE storage_deletion_queue (only after confirming no row is 'pending').

CREATE TABLE storage_deletion_queue (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  store           TEXT        NOT NULL DEFAULT 'documents' CHECK (store IN ('documents')),
  company_id      UUID        NOT NULL,
  document_id     UUID        NOT NULL,
  storage_key     TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped')),
  attempts        INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  CHECK (storage_key LIKE company_id::text || '/%'),
  UNIQUE (store, storage_key)
);

CREATE INDEX storage_deletion_queue_pending_idx ON storage_deletion_queue (next_attempt_at) WHERE status = 'pending';
