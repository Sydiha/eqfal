-- Migration 088 (T2 / G3): bank statement ending-balance reconciliation and closing integration.
-- Additive only: four new tables, their guards, and three capabilities. No existing table, row, journal rule or role is changed.
-- Capabilities are registered only. No role_capabilities row is inserted: no default role gains them; Full Access holds them through the wildcard (075).
-- Existing companies have no settings row, which means mode 'off': no closing check changes until an owner activates warn/enforce per company.
-- Rollback (only while bank_statement_balances and bank_reconciliation_snapshots are empty, and no close relied on a snapshot):
--   DROP TABLE bank_reconciliation_snapshots, bank_statement_balances, bank_account_ledger_links, company_bank_reconciliation_settings;
--   DROP FUNCTION bank_ledger_link_guard(), bank_statement_balance_guard(), bank_reconciliation_snapshot_guard();
--   DELETE FROM capabilities WHERE id IN ('bank.statement.manage','bank.statement.confirm','bank.reconciliation.settings');

INSERT INTO capabilities (id) VALUES
  ('bank.statement.manage'),
  ('bank.statement.confirm'),
  ('bank.reconciliation.settings')
ON CONFLICT (id) DO NOTHING;

-- Per-company rollout. A missing row is 'off'. 'enforce' needs an explicit effective date; earlier periods stay warnings.
CREATE TABLE company_bank_reconciliation_settings (
  company_id    UUID        PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  mode          TEXT        NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'warn', 'enforce')),
  enforce_from  DATE,
  version       INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by    UUID        NOT NULL REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (mode <> 'enforce' OR enforce_from IS NOT NULL)
);

-- Bank account -> ledger cash/bank account, with non-overlapping validity. Rows are never deleted; a link is ended by setting valid_to once.
CREATE TABLE bank_account_ledger_links (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id  UUID        NOT NULL,
  account_id       UUID        NOT NULL,
  valid_from       DATE        NOT NULL,
  valid_to         DATE,
  created_by       UUID        NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_by         UUID        REFERENCES users(id),
  ended_at         TIMESTAMPTZ,
  UNIQUE (id, company_id),
  FOREIGN KEY (bank_account_id, company_id) REFERENCES bank_accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id, company_id) REFERENCES accounts(id, company_id) ON DELETE RESTRICT,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK ((valid_to IS NULL AND ended_by IS NULL AND ended_at IS NULL) OR (valid_to IS NOT NULL AND ended_by IS NOT NULL AND ended_at IS NOT NULL))
);
CREATE INDEX bank_account_ledger_links_bank_idx ON bank_account_ledger_links (company_id, bank_account_id, valid_from);
CREATE INDEX bank_account_ledger_links_account_idx ON bank_account_ledger_links (company_id, account_id, valid_from);

CREATE FUNCTION bank_ledger_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_row RECORD;
  new_range daterange;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bank ledger links cannot be deleted; end the link instead' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Bank ledger link identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.valid_to IS NOT NULL THEN
      RAISE EXCEPTION 'An ended bank ledger link is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  SELECT account_type, cash_role INTO account_row FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id;
  IF account_row.account_type IS DISTINCT FROM 'asset' OR account_row.cash_role NOT IN ('cash', 'cash_equivalent') THEN
    RAISE EXCEPTION 'Ledger account must be an asset account with a cash or cash-equivalent role' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bank-ledger-link:' || NEW.company_id::text, 0));
  new_range := daterange(NEW.valid_from, COALESCE(NEW.valid_to + 1, 'infinity'::date), '[)');
  IF EXISTS (
    SELECT 1 FROM bank_account_ledger_links o
    WHERE o.company_id = NEW.company_id AND o.id <> NEW.id
      AND (o.bank_account_id = NEW.bank_account_id OR o.account_id = NEW.account_id)
      AND daterange(o.valid_from, COALESCE(o.valid_to + 1, 'infinity'::date), '[)') && new_range
  ) THEN
    RAISE EXCEPTION 'Bank ledger link validity overlaps an existing link for this bank account or ledger account' USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_account_ledger_links_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_account_ledger_links
  FOR EACH ROW EXECUTE FUNCTION bank_ledger_link_guard();

-- Statement ending balances. A confirmed row keeps its financial values forever; a correction is a new confirmed row that supersedes it.
CREATE TABLE bank_statement_balances (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id     UUID          NOT NULL,
  currency_code       CHAR(3)       NOT NULL,
  statement_ref       TEXT          NOT NULL CHECK (char_length(btrim(statement_ref)) BETWEEN 1 AND 100),
  period_start        DATE          NOT NULL,
  period_end          DATE          NOT NULL,
  opening_balance     NUMERIC(18,2),
  closing_balance     NUMERIC(18,2) NOT NULL,
  import_batch_id     UUID,
  note                TEXT          CHECK (note IS NULL OR char_length(note) <= 500),
  status              TEXT          NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'superseded')),
  version             INTEGER       NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes_id       UUID,
  replacement_reason  TEXT          CHECK (replacement_reason IS NULL OR char_length(btrim(replacement_reason)) BETWEEN 1 AND 500),
  created_by          UUID          NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  confirmed_by        UUID          REFERENCES users(id),
  confirmed_at        TIMESTAMPTZ,
  superseded_by       UUID          REFERENCES users(id),
  superseded_at       TIMESTAMPTZ,
  UNIQUE (id, company_id),
  FOREIGN KEY (bank_account_id, company_id) REFERENCES bank_accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (import_batch_id, company_id) REFERENCES bank_import_batches(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_id, company_id) REFERENCES bank_statement_balances(id, company_id) ON DELETE RESTRICT,
  CHECK (period_end >= period_start),
  CHECK (supersedes_id IS NULL OR (replacement_reason IS NOT NULL AND status <> 'draft')),
  CHECK ((status = 'draft' AND confirmed_by IS NULL AND confirmed_at IS NULL AND superseded_by IS NULL AND superseded_at IS NULL)
      OR (status = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND superseded_by IS NULL AND superseded_at IS NULL)
      OR (status = 'superseded' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND superseded_by IS NOT NULL AND superseded_at IS NOT NULL))
);
CREATE INDEX bank_statement_balances_account_idx ON bank_statement_balances (company_id, bank_account_id, period_end DESC);
-- At most one confirmed statement per account and period end, one live draft per account and period end, and one successor per statement.
CREATE UNIQUE INDEX bank_statement_balances_confirmed_uidx ON bank_statement_balances (company_id, bank_account_id, period_end) WHERE status = 'confirmed';
CREATE UNIQUE INDEX bank_statement_balances_draft_uidx ON bank_statement_balances (company_id, bank_account_id, period_end) WHERE status = 'draft';
CREATE UNIQUE INDEX bank_statement_balances_supersedes_uidx ON bank_statement_balances (supersedes_id) WHERE supersedes_id IS NOT NULL;
-- A statement reference identifies one live statement per account (a superseded row frees it for its replacement).
CREATE UNIQUE INDEX bank_statement_balances_ref_uidx ON bank_statement_balances (company_id, bank_account_id, lower(btrim(statement_ref))) WHERE status IN ('draft', 'confirmed');

CREATE FUNCTION bank_statement_balance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bank_currency CHAR(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Only a draft bank statement balance can be deleted' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  SELECT currency_code INTO bank_currency FROM bank_accounts WHERE id = NEW.bank_account_id AND company_id = NEW.company_id;
  IF bank_currency IS DISTINCT FROM NEW.currency_code THEN
    RAISE EXCEPTION 'Statement currency must equal the bank account currency' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'superseded' THEN
      RAISE EXCEPTION 'A statement cannot be created as superseded' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'A superseded bank statement balance is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'confirmed' THEN
    IF NEW.status <> 'superseded' THEN
      RAISE EXCEPTION 'A confirmed bank statement balance can only be superseded' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
       OR NEW.currency_code IS DISTINCT FROM OLD.currency_code OR NEW.statement_ref IS DISTINCT FROM OLD.statement_ref
       OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end
       OR NEW.opening_balance IS DISTINCT FROM OLD.opening_balance OR NEW.closing_balance IS DISTINCT FROM OLD.closing_balance
       OR NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.replacement_reason IS DISTINCT FROM OLD.replacement_reason
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
      RAISE EXCEPTION 'Confirmed bank statement balance values are immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- draft: editable; identity and creation metadata stay fixed; draft -> confirmed allowed.
  IF NEW.status = 'superseded' THEN
    RAISE EXCEPTION 'A draft cannot be superseded' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Bank statement balance identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_balances_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_balances
  FOR EACH ROW EXECUTE FUNCTION bank_statement_balance_guard();

-- Evidence recorded when a monthly or fiscal-year close is approved with reconciliation active. Append-only.
CREATE TABLE bank_reconciliation_snapshots (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id  UUID          NOT NULL,
  scope            TEXT          NOT NULL CHECK (scope IN ('monthly_close', 'fiscal_year_close')),
  scope_id         UUID          NOT NULL,
  period_end       DATE          NOT NULL,
  statement_id     UUID,
  mode             TEXT          NOT NULL CHECK (mode IN ('warn', 'enforce')),
  outcome          TEXT          NOT NULL CHECK (outcome IN ('reconciled', 'attention')),
  difference       NUMERIC(18,2),
  result           JSONB         NOT NULL,
  result_sha256    TEXT          NOT NULL CHECK (result_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by      UUID          NOT NULL REFERENCES users(id),
  recorded_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (id, company_id),
  FOREIGN KEY (bank_account_id, company_id) REFERENCES bank_accounts(id, company_id) ON DELETE RESTRICT,
  FOREIGN KEY (statement_id, company_id) REFERENCES bank_statement_balances(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX bank_reconciliation_snapshots_scope_idx ON bank_reconciliation_snapshots (company_id, scope, scope_id, recorded_at DESC);

CREATE FUNCTION bank_reconciliation_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Bank reconciliation snapshots are append-only' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER bank_reconciliation_snapshots_guard BEFORE UPDATE OR DELETE ON bank_reconciliation_snapshots
  FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_snapshot_guard();
