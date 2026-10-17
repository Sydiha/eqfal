import { afterEach, describe, expect, it } from 'vitest';
import { assertDisposableTestDatabase } from './helpers/authority-fixture';

const client = (name: string) => ({ query: async () => ({ rows: [{ name }] }) }) as never;
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });
const set = (url: string | undefined, extra: Record<string, string | undefined> = {}) => {
  if (url === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = url;
  delete process.env['EQFAL_TEST_DB_DISPOSABLE'];
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

describe('test-only trigger fixture guard', () => {
  it('accepts a local database named as a test database (CI and local socket)', async () => {
    set('postgresql://eqfal:x@127.0.0.1:5432/eqfal_ci');
    await expect(assertDisposableTestDatabase(client('eqfal_ci'))).resolves.toBeUndefined();
    set('postgresql://eqfal@localhost:5433/eqfal_test?host=/var/run/pg');
    await expect(assertDisposableTestDatabase(client('eqfal_test'))).resolves.toBeUndefined();
  });
  it('refuses a non-test database name even locally, and does not trust NODE_ENV=test', async () => {
    set('postgresql://eqfal@127.0.0.1/eqfal', { NODE_ENV: 'test' });
    await expect(assertDisposableTestDatabase(client('eqfal'))).rejects.toThrow(/not named as a test database/);
    await expect(assertDisposableTestDatabase(client('neondb'))).rejects.toThrow(/not named as a test database/);
  });
  it('refuses a remote test-named database unless it is explicitly confirmed by exact name', async () => {
    set('postgresql://u:p@db.example.com/eqfal_test');
    await expect(assertDisposableTestDatabase(client('eqfal_test'))).rejects.toThrow(/not confirmed disposable/);
    set('postgresql://u:p@db.example.com/eqfal_test', { EQFAL_TEST_DB_DISPOSABLE: 'other_test' });
    await expect(assertDisposableTestDatabase(client('eqfal_test'))).rejects.toThrow(/not confirmed disposable/);
    set('postgresql://u:p@db.example.com/eqfal_test', { EQFAL_TEST_DB_DISPOSABLE: 'eqfal_test' });
    await expect(assertDisposableTestDatabase(client('eqfal_test'))).resolves.toBeUndefined();
  });
  it('refuses in production or without DATABASE_URL', async () => {
    set('postgresql://eqfal@127.0.0.1/eqfal_test', { NODE_ENV: 'production' });
    await expect(assertDisposableTestDatabase(client('eqfal_test'))).rejects.toThrow(/production/);
    set(undefined, { NODE_ENV: 'test' });
    await expect(assertDisposableTestDatabase(client('eqfal_test'))).rejects.toThrow(/DATABASE_URL/);
  });
});
