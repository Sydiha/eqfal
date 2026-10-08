import pool from './pool';
import { runMigrations } from './migrate';

// Applies all migrations to DATABASE_URL and exits. Used by CI to prepare the test database.
async function main(): Promise<void> {
  if (!pool) throw new Error('DATABASE_URL is not set');
  await runMigrations(pool);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
