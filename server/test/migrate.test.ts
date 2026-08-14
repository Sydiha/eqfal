/**
 * Targeted tests for runMigrations security properties:
 *   1. Advisory lock is acquired with the correct key
 *   2. Advisory lock is released after a successful run
 *   3. Advisory lock is released even when a migration fails
 *   4. Failed migration triggers ROLLBACK (not COMMIT)
 *   5. Error propagates out of runMigrations (startup contract)
 *
 * These tests use pure in-memory mocks — no real DB, no real filesystem.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';

// ─── fs mock — declared before importing migrate ──────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Silence logger output in tests
vi.mock('../src/shared/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as fs from 'fs';
import { runMigrations } from '../src/db/migrate';

// ─── helpers ─────────────────────────────────────────────────────────────────

const LOCK_KEY = 7_432_091;

/** Build a PoolClient mock with a controllable query spy. */
function makeClient(querySpy?: ReturnType<typeof vi.fn>): PoolClient {
  return {
    query: querySpy ?? vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  } as unknown as PoolClient;
}

/**
 * Build a Pool mock.
 * connect() hands out `clients` in order; extra calls get a no-op fallback.
 * pool.query() (the SELECT already-applied check) returns `checkResult`.
 */
function makePool(
  clients: PoolClient[],
  checkResult: { rows: any[]; rowCount: number } = { rows: [], rowCount: 0 },
): Pool {
  let idx = 0;
  const fallback = makeClient();
  return {
    connect: vi.fn().mockImplementation(() => {
      const client = idx < clients.length ? clients[idx] : fallback;
      idx++;
      return Promise.resolve(client);
    }),
    query: vi.fn().mockResolvedValue(checkResult),
  } as unknown as Pool;
}

// ─── advisory lock — normal flow ──────────────────────────────────────────────

describe('runMigrations — advisory lock acquired and released', () => {
  beforeEach(() => {
    // No migrations directory → loop is skipped; cleanest setup for lock tests
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('acquires pg_advisory_lock with the stable lock key', async () => {
    const lockClient = makeClient();
    const trackingClient = makeClient();
    const pool = makePool([lockClient, trackingClient]);

    await runMigrations(pool);

    expect(lockClient.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_lock($1)',
      [LOCK_KEY],
    );
  });

  it('releases pg_advisory_unlock with the same key on success', async () => {
    const lockClient = makeClient();
    const trackingClient = makeClient();
    const pool = makePool([lockClient, trackingClient]);

    await runMigrations(pool);

    expect(lockClient.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [LOCK_KEY],
    );
    expect(lockClient.release).toHaveBeenCalledOnce();
  });

  it('calls unlock before release (correct finally-block order)', async () => {
    const order: string[] = [];
    const lockQuery = vi.fn().mockImplementation(async (sql: string) => {
      if (String(sql).includes('advisory_unlock')) order.push('unlock');
      return { rows: [], rowCount: 0 };
    });
    const lockClient = {
      query: lockQuery,
      release: vi.fn().mockImplementation(() => order.push('release')),
    } as unknown as PoolClient;

    const trackingClient = makeClient();
    const pool = makePool([lockClient, trackingClient]);

    await runMigrations(pool);

    expect(order).toEqual(['unlock', 'release']);
  });
});

// ─── advisory lock released on failure ───────────────────────────────────────

describe('runMigrations — advisory lock released when migration fails', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['001_fail.sql'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue('BAD DDL;');
  });

  it('releases pg_advisory_unlock even when migration SQL throws', async () => {
    const lockClient = makeClient();
    const trackingClient = makeClient();

    // migrationClient: BEGIN ok → SQL throws → ROLLBACK ok
    const migrationQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockRejectedValueOnce(new Error('DDL failed'))   // SQL
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
    const migrationClient = makeClient(migrationQuery);

    // pool.query (SELECT check): migration not yet applied
    const pool = makePool([lockClient, trackingClient, migrationClient], {
      rows: [],
      rowCount: 0,
    });

    await expect(runMigrations(pool)).rejects.toThrow('DDL failed');

    expect(lockClient.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [LOCK_KEY],
    );
    expect(lockClient.release).toHaveBeenCalledOnce();
  });
});

// ─── rollback on migration failure ───────────────────────────────────────────

describe('runMigrations — transaction rollback', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['001_fail.sql'] as any);
    vi.mocked(fs.readFileSync).mockReturnValue('BAD DDL;');
  });

  it('issues ROLLBACK (not COMMIT) when migration SQL throws', async () => {
    const lockClient = makeClient();
    const trackingClient = makeClient();

    // Per-call sequence: BEGIN ok → SQL throws → ROLLBACK ok.
    // mockImplementationOnce avoids relying on the exact SQL string from readFileSync.
    const migrationQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockRejectedValueOnce(new Error('syntax error'))  // SQL (actual DDL)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
    const migrationClient = makeClient(migrationQuery);

    const pool = makePool([lockClient, trackingClient, migrationClient], {
      rows: [],
      rowCount: 0,
    });

    await expect(runMigrations(pool)).rejects.toThrow('syntax error');

    // Verify issued SQL in order: BEGIN … ROLLBACK, no COMMIT
    const issuedSql = (migrationQuery.mock.calls as [string][]).map(([sql]) =>
      String(sql).trim(),
    );
    expect(issuedSql).toContain('BEGIN');
    expect(issuedSql).toContain('ROLLBACK');
    expect(issuedSql).not.toContain('COMMIT');
  });

  it('error from failed migration propagates out of runMigrations', async () => {
    const lockClient = makeClient();
    const trackingClient = makeClient();

    const migrationQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockRejectedValueOnce(new Error('fatal DDL'))    // SQL
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK
    const migrationClient = makeClient(migrationQuery);

    const pool = makePool([lockClient, trackingClient, migrationClient], {
      rows: [],
      rowCount: 0,
    });

    await expect(runMigrations(pool)).rejects.toThrow('fatal DDL');
  });
});

// ─── startup failure contract ─────────────────────────────────────────────────

describe('runMigrations — startup failure contract (DATABASE_URL set)', () => {
  it('throws when pool.connect() fails (DB unreachable)', async () => {
    // pool.connect() is the first call in runMigrations (for the lock client).
    // If it throws, runMigrations throws — index.ts re-throws → process.exit(1).
    const pool = {
      connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      query: vi.fn(),
    } as unknown as Pool;

    await expect(runMigrations(pool)).rejects.toThrow('ECONNREFUSED');
  });

  it('throws when ensureTrackingTable fails, and still releases the lock', async () => {
    const lockClient = makeClient();
    // trackingClient: BEGIN throws immediately
    const trackingQuery = vi.fn().mockRejectedValue(new Error('permission denied'));
    const trackingClient = makeClient(trackingQuery);

    const pool = makePool([lockClient, trackingClient]);

    await expect(runMigrations(pool)).rejects.toThrow('permission denied');

    // The advisory lock must still be released despite the failure
    expect(lockClient.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      [LOCK_KEY],
    );
    expect(lockClient.release).toHaveBeenCalledOnce();
  });
});
