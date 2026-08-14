import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import logger from '../shared/logger';

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

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

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO _schema_migrations (filename) VALUES ($1)', [
      file,
    ]);
    logger.info({ file }, 'Applied migration');
  }
}
