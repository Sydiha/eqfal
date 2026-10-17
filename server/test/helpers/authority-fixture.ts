import type { Pool } from 'pg';

/**
 * TEST-ONLY fixture: seeds an ACTIVE ledger source authority range in a disposable test database (DATABASE_URL suites only).
 * Since migration 085 no application or SQL path can create an active range (activation arrives with the cut-over workflow, C1B-3b), so
 * the suites that exercise the 083 posting guard need a seeded row. The insert guard is disabled ONLY inside this one transaction
 * (ALTER TABLE is transactional and holds an ACCESS EXCLUSIVE lock until COMMIT, so no other session ever sees the trigger disabled).
 * It requires the test role to own ledger_source_authority; nothing in application code does this. Never point DATABASE_URL at a real database.
 */
export async function seedActiveAuthorityRange(db: Pool, companyId: string, actor: string, fromDate: string, toDate: string, reason = 'External (test fixture)') {
  if (process.env['NODE_ENV'] === 'production') throw new Error('seedActiveAuthorityRange is test-only');
  const client = await db.connect();
  try {
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
