import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

// In CI (REQUIRE_POSTGRES_TESTS=true) the PostgreSQL-backed suites must really run, never silently skip.
describe('PostgreSQL availability guard', () => {
  const required = process.env['REQUIRE_POSTGRES_TESTS'] === 'true';

  it.runIf(required)('has a reachable, fully migrated database', async () => {
    const url = process.env['DATABASE_URL'];
    expect(url, 'DATABASE_URL must be set when REQUIRE_POSTGRES_TESTS=true').toBeTruthy();
    const pool = new Pool({ connectionString: url });
    try {
      const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM _schema_migrations');
      expect(rows[0]!.n).toBeGreaterThanOrEqual(61);
    } finally {
      await pool.end();
    }
  });
});
