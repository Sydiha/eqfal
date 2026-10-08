import bcrypt from 'bcrypt';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate';
import { BootstrapError, bootstrapInitialAdmin } from '../src/modules/bootstrap/bootstrap.service';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const PASSWORD = 'synthetic-Test-Pass-1!';
const base = () => ({ email: 'Admin@Example.Test', password: PASSWORD, company: { slug: 'synthetic-co', name: 'Synthetic Co', name_ar: 'شركة تجريبية' } });

// Runs on its own throwaway database: the shared test database holds other suites' users/companies.
describeDatabase('initial company & administrator bootstrap (disposable PostgreSQL)', () => {
  const dbName = `eqfal_bootstrap_${randomBytes(6).toString('hex')}`;
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const testUrl = new URL(databaseUrl as string);
  testUrl.pathname = `/${dbName}`;
  let pool: Pool;

  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE ${dbName}`);
    pool = new Pool({ connectionString: testUrl.toString(), max: 10 });
    await runMigrations(pool);
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await adminPool.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE audit_log, memberships, role_capabilities, roles, sessions, users, companies CASCADE');
  });

  const counts = async () => (await pool.query<{ u: string; c: string; r: string; m: string }>(
    'SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM companies) c, (SELECT count(*) FROM roles) r, (SELECT count(*) FROM memberships) m')).rows[0]!;

  it('creates user, company, 4 default roles, Full Access membership and audit entries', async () => {
    const result = await bootstrapInitialAdmin(pool, base());
    expect(await counts()).toEqual({ u: '1', c: '1', r: '4', m: '1' });
    const user = (await pool.query('SELECT * FROM users WHERE id=$1', [result.userId])).rows[0];
    expect(user.email).toBe('admin@example.test');
    expect(user.password_hash).not.toContain(PASSWORD);
    expect(await bcrypt.compare(PASSWORD, user.password_hash)).toBe(true);
    const role = (await pool.query(
      `SELECT r.name, r.is_full_access FROM memberships m JOIN roles r ON r.id=m.role_id WHERE m.user_id=$1 AND m.company_id=$2 AND m.is_active`,
      [result.userId, result.companyId])).rows;
    expect(role).toEqual([{ name: 'Full Access', is_full_access: true }]);
    const names = (await pool.query('SELECT name FROM roles ORDER BY name')).rows.map((r) => r.name);
    expect(names).toEqual(['Accountant', 'Finance Manager', 'Full Access', 'Viewer']);
    const actions = (await pool.query('SELECT action FROM audit_log ORDER BY action')).rows.map((r) => r.action);
    expect(actions).toEqual(['bootstrap.initialize', 'company.create']);
    const audit = JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows);
    expect(audit).not.toContain(PASSWORD);
    expect(audit).not.toContain(user.password_hash);
  });

  it.each([
    ['bad email', { email: 'nope' }],
    ['short password', { password: 'short' }],
    ['password over 72 bytes', { password: 'x'.repeat(73) }],
  ])('rejects invalid input (%s) and writes nothing', async (_n, patch) => {
    await expect(bootstrapInitialAdmin(pool, { ...base(), ...patch })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await counts()).toEqual({ u: '0', c: '0', r: '0', m: '0' });
  });
  it('rejects invalid slug', async () => {
    await expect(bootstrapInitialAdmin(pool, { ...base(), company: { slug: 'Bad Slug', name: 'X', name_ar: null } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('fails closed when a user already exists, leaving data untouched', async () => {
    await pool.query("INSERT INTO users(email,password_hash) VALUES('existing@example.test','h')");
    await expect(bootstrapInitialAdmin(pool, base())).rejects.toMatchObject({ code: 'ALREADY_INITIALIZED' });
    expect(await counts()).toEqual({ u: '1', c: '0', r: '0', m: '0' });
    expect((await pool.query('SELECT password_hash FROM users')).rows[0].password_hash).toBe('h');
  });
  it('fails closed when a company already exists, leaving data untouched', async () => {
    await pool.query("INSERT INTO companies(slug,name) VALUES('old','Old')");
    await expect(bootstrapInitialAdmin(pool, base())).rejects.toBeInstanceOf(BootstrapError);
    expect(await counts()).toEqual({ u: '0', c: '1', r: '0', m: '0' });
  });

  it('repeated execution is refused and changes nothing', async () => {
    const first = await bootstrapInitialAdmin(pool, base());
    const hash = (await pool.query('SELECT password_hash FROM users')).rows[0].password_hash;
    await expect(bootstrapInitialAdmin(pool, { ...base(), email: 'other@example.test' })).rejects.toMatchObject({ code: 'ALREADY_INITIALIZED' });
    expect(await counts()).toEqual({ u: '1', c: '1', r: '4', m: '1' });
    expect((await pool.query('SELECT id, password_hash FROM users')).rows[0]).toEqual({ id: first.userId, password_hash: hash });
  });

  it('concurrent executions: exactly one succeeds, no duplicates', async () => {
    const runs = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
      bootstrapInitialAdmin(pool, { ...base(), email: `admin${i}@example.test`, company: { slug: `co-${i}`, name: `Co ${i}`, name_ar: null } })));
    expect(runs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of runs.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'ALREADY_INITIALIZED' });
    expect(await counts()).toEqual({ u: '1', c: '1', r: '4', m: '1' });
  }, 60_000);

  describe('CLI', () => {
    const cli = path.resolve(__dirname, '../src/cli/bootstrap-admin.ts');
    const run = (args: string[], input: string) => spawnSync('npx', ['tsx', cli, ...args], {
      input, encoding: 'utf8', env: { ...process.env, DATABASE_URL: testUrl.toString() }, cwd: path.resolve(__dirname, '..'),
    });
    const good = ['--email', 'cli@example.test', '--company-slug', 'cli-co', '--company-name', 'CLI Co', '--confirm-slug', 'cli-co'];

    it('refuses without explicit confirmation', async () => {
      const r = run(good.slice(0, -2), `${PASSWORD}\n`);
      expect(r.status).toBe(1);
      expect(await counts()).toEqual({ u: '0', c: '0', r: '0', m: '0' });
    }, 60_000);
    it('bootstraps from stdin password without echoing it, then refuses a second run', async () => {
      const r = run(good, `${PASSWORD}\n`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout + r.stderr).not.toContain(PASSWORD);
      expect(await counts()).toEqual({ u: '1', c: '1', r: '4', m: '1' });
      const again = run(good, `${PASSWORD}\n`);
      expect(again.status).toBe(2);
      expect(again.stdout + again.stderr).not.toContain(PASSWORD);
    }, 60_000);
    it('rejects a password passed as an argument', () => {
      const r = run([...good, '--password', PASSWORD], '');
      expect(r.status).toBe(1);
    }, 60_000);
  });
});
