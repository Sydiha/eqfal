import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('migration bootstrap on an empty PostgreSQL database', () => {
  const admin = new Pool({ connectionString: databaseUrl });
  const dbName = `mig_bootstrap_${randomUUID().replace(/-/g, '')}`;
  let pool: Pool;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString() });
  });
  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  it('applies every migration from 001 to the latest (059, 060, 061 included)', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM _schema_migrations');
    const names = rows.map((r) => r.filename);
    for (const prefix of ['059_', '060_', '061_']) {
      expect(names.some((n) => n.startsWith(prefix))).toBe(true);
    }
    expect((await pool.query("SELECT to_regclass('company_logos') AS t")).rows[0].t).toBe('company_logos');
  });

  it('seeds no environment-specific roles or monthly-close periods', async () => {
    expect((await pool.query('SELECT count(*)::int AS n FROM roles')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM monthly_close_periods')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM capabilities')).rows[0].n).toBeGreaterThan(100);
  });

  it('rerunning the runner is a no-op', async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM _schema_migrations')).rows[0].n;
    await runMigrations(pool);
    expect((await pool.query('SELECT count(*)::int AS n FROM _schema_migrations')).rows[0].n).toBe(before);
  });

  it('has no orphaned role_capabilities rows', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM role_capabilities rc
       LEFT JOIN roles r ON r.id = rc.role_id
       LEFT JOIN capabilities c ON c.id = rc.capability_id
       WHERE r.id IS NULL OR c.id IS NULL`,
    );
    expect(rows).toHaveLength(0);
  });
});
