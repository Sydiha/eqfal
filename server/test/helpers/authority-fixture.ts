import type { Pool, PoolClient } from 'pg';

const TEST_DATABASE_NAME = /(^|_)(test|tests|ci|scratch)(_|$)/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

/**
 * Refuses unless the CONNECTED database is verifiably a disposable test database (NODE_ENV alone is not trusted):
 *   1. the server-reported current_database() name is a test name (e.g. eqfal_test, eqfal_ci), and
 *   2. the server is local (CI service container / local socket), or EQFAL_TEST_DB_DISPOSABLE names that exact database explicitly.
 */
export async function assertDisposableTestDatabase(client: Pick<PoolClient, 'query'>): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') throw new Error('Refusing test-only trigger fixture: NODE_ENV=production');
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('Refusing test-only trigger fixture: DATABASE_URL is not set');
  const parsed = new URL(url);
  const socketHost = parsed.searchParams.get('host');
  const host = socketHost?.startsWith('/') ? '' : (socketHost ?? parsed.hostname);
  const name = (await client.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name;
  if (!TEST_DATABASE_NAME.test(name)) throw new Error(`Refusing test-only trigger fixture: database "${name}" is not named as a test database`);
  if (!LOCAL_HOSTS.has(host) && process.env['EQFAL_TEST_DB_DISPOSABLE'] !== name) {
    throw new Error(`Refusing test-only trigger fixture: remote database "${name}" is not confirmed disposable (set EQFAL_TEST_DB_DISPOSABLE=${name})`);
  }
}

/**
 * TEST-ONLY fixture: seeds an ACTIVE ledger source authority range in a disposable test database (DATABASE_URL suites only).
 * Since migration 085 no application or SQL path can create an active range (activation arrives with the cut-over workflow, C1B-3b), so
 * the suites that exercise the 083 posting guard need a seeded row. The insert guard is disabled ONLY inside this one transaction
 * (ALTER TABLE is transactional and holds an ACCESS EXCLUSIVE lock until COMMIT, so no other session ever sees the trigger disabled).
 * It requires the test role to own ledger_source_authority and refuses any database not verified by assertDisposableTestDatabase();
 * nothing in application code does this.
 */
export async function seedActiveAuthorityRange(db: Pool, companyId: string, actor: string, fromDate: string, toDate: string, reason = 'External (test fixture)') {
  const client = await db.connect();
  try {
    await assertDisposableTestDatabase(client);
    await client.query('BEGIN');
    await client.query('ALTER TABLE ledger_source_authority DISABLE TRIGGER ledger_source_authority_guard_insert');
    const row = (await client.query<{ id: string; status: string }>(
      "INSERT INTO ledger_source_authority(company_id,from_date,to_date,authority,status,reason,created_by) VALUES($1,$2,$3,'external_reference_only','active',$4,$5) RETURNING id,status",
      [companyId, fromDate, toDate, reason, actor],
    )).rows[0]!;
    await client.query('ALTER TABLE ledger_source_authority ENABLE TRIGGER ledger_source_authority_guard_insert');
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * TEST-ONLY fixture: turns a range activated by the current code into what a PRE-S1 activation stored (four acknowledgements, no
 * tb_source_system / tb_basis in the snapshot, the pre-S1 payload hash), so backward-compatible replay can be tested. The update guard is
 * disabled only inside this one transaction, under the same disposable-database checks as seedActiveAuthorityRange.
 */
export async function rewriteAsPreS1Activation(db: Pool, rangeId: string, legacyPayloadHash: string) {
  const client = await db.connect();
  try {
    await assertDisposableTestDatabase(client);
    await client.query('BEGIN');
    await client.query('ALTER TABLE ledger_source_authority DISABLE TRIGGER ledger_source_authority_guard_update');
    await client.query(
      `UPDATE ledger_source_authority SET acknowledgements=acknowledgements - 'pre_closing_trial_balance',
         activation_snapshot=activation_snapshot - 'tb_basis' - 'tb_source_system', activation_payload_hash=$2 WHERE id=$1`,
      [rangeId, legacyPayloadHash],
    );
    await client.query('ALTER TABLE ledger_source_authority ENABLE TRIGGER ledger_source_authority_guard_update');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
