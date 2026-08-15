-- Migration 006: audit log
--
-- Immutable, append-only log for sensitive entity changes.
--
-- Design rules:
--   · before_data / after_data are JSONB snapshots of entity state.
--     They must NEVER contain passwords, hashes, tokens, or secrets.
--   · audit_log rows are never updated or deleted.
--   · Writes always share the caller's transaction so that an entity
--     change and its audit entry are committed atomically — a rollback
--     removes both.
--   · company_id is always stored for tenant-scoped queries.
--   · actor_user_id records who performed the action.

CREATE TABLE audit_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID        NOT NULL REFERENCES companies(id),
  actor_user_id  UUID        NOT NULL REFERENCES users(id),
  action         TEXT        NOT NULL,   -- e.g. 'fiscal_year.create'
  entity_type    TEXT        NOT NULL,   -- e.g. 'fiscal_year'
  entity_id      UUID        NOT NULL,
  before_data    JSONB,                  -- nullable — absent on creation events
  after_data     JSONB,                  -- nullable — absent on deletion events
  reason         TEXT,                   -- optional free-text justification
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_log_company_idx     ON audit_log (company_id);
CREATE INDEX audit_log_entity_idx      ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_created_at_idx  ON audit_log (created_at);
