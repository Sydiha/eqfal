import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import logger from '../shared/logger';

/**
 * Ensures the _schema_migrations tracking table exists.
 * Runs inside its own transaction so the create is atomic.
 */
async function ensureTrackingTable(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        id          SERIAL      PRIMARY KEY,
        filename    TEXT        NOT NULL UNIQUE,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies a single migration file inside an atomic transaction.
 * If the DDL or the tracking INSERT fails, the whole transaction rolls back
 * so the migration can be safely retried on the next startup.
 */
async function applyMigration(pool: Pool, file: string, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO _schema_migrations (filename) VALUES ($1)',
      [file],
    );
    await client.query('COMMIT');
    logger.info({ file }, 'Applied migration');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err, file }, 'Migration failed — rolled back');
    throw err;
  } finally {
    client.release();
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  await ensureTrackingTable(pool);

  const migrationsDir = path.resolve(__dirname, '../../migrations');

  if (!fs.existsSync(migrationsDir)) {
    logger.warn('migrations/ directory not found, skipping');
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await pool.query(
      'SELECT id FROM _schema_migrations WHERE filename = $1',
      [file],
    );

    if (rows.length > 0) {
      logger.debug({ file }, 'Migration already applied, skipping');
      continue;
    }

    const sql = fs.readFileSync(
      path.join(migrationsDir, file),
      'utf8',
    );

    await applyMigration(pool, file, sql);
  }
}
