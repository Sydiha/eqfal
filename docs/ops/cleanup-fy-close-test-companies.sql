-- Cleanup of test companies named exactly 'FY Close' (Owner-authorized, 2026-10-15).
--
-- Run from Replit Shell against the EXPERIMENTAL database only. See cleanup-fy-close-test-companies.md.
--
--   Dry run (default, always rolls back):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/ops/cleanup-fy-close-test-companies.sql
--   Execute (commits only if every check passes):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v commit=yes -v expect=<N> [-v delete_audit=yes] \
--          -f docs/ops/cleanup-fy-close-test-companies.sql
--
-- Safety properties:
--   * One transaction. Any error (including a ledger/invoice immutability trigger) aborts everything: no partial deletion.
--   * Targets only companies whose name is exactly 'FY Close' (case-sensitive, no trim, no pattern match).
--   * Never disables triggers or constraints, never uses session_replication_role, no TRUNCATE.
--   * Rows are removed child-first by company_id, in an order derived from the live FK graph. Only rows whose
--     company_id is a target are touched; users, other companies, shared reference data (capabilities,
--     vat_standard_rates) and sessions are left alone (sessions.active_company_id is cleared by its own FK rule).
--   * audit_log is append-only by policy; its rows are removed only when -v delete_audit=yes is given.
--   * commit=yes requires expect=<N> to equal the number of matched companies.

\set ON_ERROR_STOP on
\if :{?commit}
\else
  \set commit no
\endif
\if :{?delete_audit}
\else
  \set delete_audit no
\endif
\if :{?expect}
\else
  \set expect -1
\endif

BEGIN;
SET LOCAL lock_timeout = '10s';
-- psql variables are not expanded inside $$ bodies, so hand them to PL/pgSQL as transaction settings.
SELECT set_config('fy.commit', :'commit', true), set_config('fy.expect', :'expect', true), set_config('fy.delete_audit', :'delete_audit', true) \gset

CREATE TEMP TABLE _fy_targets ON COMMIT DROP AS
  SELECT id, slug, name, name_ar, is_active, created_at FROM companies WHERE name = 'FY Close';

\echo '== Matched companies (name exactly "FY Close") =='
SELECT id, slug, name, name_ar, is_active, created_at FROM _fy_targets ORDER BY created_at;

\echo '== Excluded look-alikes (NOT touched) =='
SELECT id, slug, name FROM companies
 WHERE name <> 'FY Close' AND (name ILIKE '%fy%close%' OR name ILIKE '%fy%') ORDER BY name;

-- Baseline of everything that must stay untouched.
CREATE TEMP TABLE _fy_baseline ON COMMIT DROP AS
  SELECT (SELECT count(*) FROM companies WHERE name <> 'FY Close') AS other_companies,
         (SELECT count(*) FROM users) AS users,
         (SELECT count(*) FROM memberships WHERE company_id NOT IN (SELECT id FROM _fy_targets)) AS other_memberships,
         (SELECT count(*) FROM vat_standard_rates) AS vat_rates,
         (SELECT count(*) FROM capabilities) AS capabilities;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM _fy_targets;
  IF n = 0 THEN RAISE EXCEPTION 'No company named exactly "FY Close" found. Nothing to do.'; END IF;
  IF current_setting('fy.commit') = 'yes' AND n <> current_setting('fy.expect')::int THEN
    RAISE EXCEPTION 'expect=% does not match matched companies=%: aborting', current_setting('fy.expect'), n;
  END IF;
END $$;

-- Per-table inventory of the rows that will be removed (company-scoped tables only).
CREATE TEMP TABLE _fy_inventory (table_name text, rows_to_delete bigint) ON COMMIT DROP;
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
             JOIN information_schema.tables x ON x.table_schema=c.table_schema AND x.table_name=c.table_name AND x.table_type='BASE TABLE'
            WHERE c.table_schema='public' AND c.column_name='company_id' ORDER BY 1
  LOOP
    EXECUTE format('INSERT INTO _fy_inventory SELECT %L, count(*) FROM %I WHERE company_id IN (SELECT id FROM _fy_targets)', t, t);
  END LOOP;
  INSERT INTO _fy_inventory SELECT 'system_audit_log (blocks if >0: append-only)', count(*) FROM system_audit_log WHERE company_id IN (SELECT id FROM _fy_targets);
  INSERT INTO _fy_inventory SELECT 'sessions.active_company_id (set to NULL)', count(*) FROM sessions WHERE active_company_id IN (SELECT id FROM _fy_targets);
END $$;

\echo '== Rows that will be deleted, by table (non-zero only) =='
SELECT table_name, rows_to_delete FROM _fy_inventory WHERE rows_to_delete > 0 ORDER BY table_name;

\echo '== Integrity-sensitive rows (may block deletion) =='
SELECT 'posted journal entries' AS item, count(*) FROM journal_entries WHERE status='posted' AND company_id IN (SELECT id FROM _fy_targets)
UNION ALL SELECT 'non-draft invoices', count(*) FROM invoices WHERE status<>'draft' AND company_id IN (SELECT id FROM _fy_targets)
UNION ALL SELECT 'audit_log rows', count(*) FROM audit_log WHERE company_id IN (SELECT id FROM _fy_targets)
UNION ALL SELECT 'system_audit_log rows', count(*) FROM system_audit_log WHERE company_id IN (SELECT id FROM _fy_targets);

-- Audit rows: policy gate.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM audit_log WHERE company_id IN (SELECT id FROM _fy_targets);
  IF n > 0 AND current_setting('fy.delete_audit') <> 'yes' THEN
    RAISE NOTICE 'BLOCKER (policy): % audit_log rows reference the target companies; audit_log is append-only by policy. The FK (no cascade) prevents company deletion unless they are removed. Re-run with -v delete_audit=yes only if the Owner confirms.', n;
    RAISE EXCEPTION 'Aborted: audit_log rows present and delete_audit not confirmed';
  END IF;
END $$;

-- Ledger gate. protect_posted_journal() (migration 021) raises for posted entries and, for DRAFT entries, returns NEW on
-- DELETE (which is NULL), so a plain DELETE of a draft journal is silently skipped. Entries therefore cannot be removed
-- without altering or disabling that trigger, which is forbidden here. Stop instead of attempting a partial deletion.
DO $$
DECLARE posted bigint; draft bigint;
BEGIN
  SELECT count(*) FILTER (WHERE status='posted'), count(*) FILTER (WHERE status<>'posted') INTO posted, draft
    FROM journal_entries WHERE company_id IN (SELECT id FROM _fy_targets);
  IF posted + draft > 0 THEN
    RAISE EXCEPTION 'BLOCKER: target companies own % posted and % draft journal entries. The ledger immutability triggers forbid deleting them and this script will not disable them. Nothing was deleted.', posted, draft;
  END IF;
END $$;

-- Child-first deletion derived from the FK graph (deferrable FKs and self-references are not edges).
DO $$
DECLARE
  remaining text[];
  t text; progressed boolean; deleted bigint; leftover bigint;
BEGIN
  SELECT array_agg(c.table_name ORDER BY c.table_name) INTO remaining
    FROM information_schema.columns c
    JOIN information_schema.tables x ON x.table_schema=c.table_schema AND x.table_name=c.table_name AND x.table_type='BASE TABLE'
   WHERE c.table_schema='public' AND c.column_name='company_id';

  WHILE coalesce(array_length(remaining,1),0) > 0 LOOP
    progressed := false;
    FOREACH t IN ARRAY remaining LOOP
      -- t can be deleted when no other remaining table still has a non-deferrable FK pointing at it
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint k
         WHERE k.contype='f' AND NOT k.condeferrable
           AND k.confrelid = to_regclass(quote_ident(t))
           AND k.conrelid <> k.confrelid
           AND k.conrelid::regclass::text = ANY (remaining)
      ) THEN
        EXECUTE format('DELETE FROM %I WHERE company_id IN (SELECT id FROM _fy_targets)', t);
        GET DIAGNOSTICS deleted = ROW_COUNT;
        IF deleted > 0 THEN RAISE NOTICE 'deleted % rows from %', deleted, t; END IF;
        -- A BEFORE DELETE trigger that returns NULL skips rows silently; never trust the statement alone.
        EXECUTE format('SELECT count(*) FROM %I WHERE company_id IN (SELECT id FROM _fy_targets)', t) INTO leftover;
        IF leftover > 0 THEN RAISE EXCEPTION 'BLOCKER: % rows of % could not be deleted (guard trigger). Nothing was deleted.', leftover, t; END IF;
        remaining := array_remove(remaining, t);
        progressed := true;
      END IF;
    END LOOP;
    IF NOT progressed THEN
      RAISE EXCEPTION 'Unresolvable FK cycle among: %', remaining;
    END IF;
  END LOOP;

  DELETE FROM companies WHERE id IN (SELECT id FROM _fy_targets);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RAISE NOTICE 'deleted % rows from companies', deleted;
END $$;

-- Post-conditions: targets gone, everything else unchanged.
DO $$
DECLARE b _fy_baseline%ROWTYPE; leftover bigint;
BEGIN
  SELECT * INTO b FROM _fy_baseline;
  IF (SELECT count(*) FROM companies WHERE name='FY Close') <> 0 THEN RAISE EXCEPTION 'FY Close company still present'; END IF;
  IF (SELECT count(*) FROM companies WHERE name <> 'FY Close') <> b.other_companies THEN RAISE EXCEPTION 'other companies changed'; END IF;
  IF (SELECT count(*) FROM users) <> b.users THEN RAISE EXCEPTION 'users changed'; END IF;
  IF (SELECT count(*) FROM memberships WHERE company_id NOT IN (SELECT id FROM _fy_targets)) <> b.other_memberships THEN RAISE EXCEPTION 'other memberships changed'; END IF;
  IF (SELECT count(*) FROM vat_standard_rates) <> b.vat_rates THEN RAISE EXCEPTION 'vat_standard_rates changed'; END IF;
  IF (SELECT count(*) FROM capabilities) <> b.capabilities THEN RAISE EXCEPTION 'capabilities changed'; END IF;
  SELECT count(*) INTO leftover FROM audit_log WHERE company_id IN (SELECT id FROM _fy_targets);
  IF leftover <> 0 THEN RAISE EXCEPTION 'audit rows remain'; END IF;
END $$;

\echo '== All post-conditions passed =='
SELECT :'commit' = 'yes' AS do_commit \gset
\if :do_commit
  \echo '== COMMIT =='
  COMMIT;
\else
  \echo '== DRY RUN: ROLLBACK (nothing was changed) =='
  ROLLBACK;
\endif
