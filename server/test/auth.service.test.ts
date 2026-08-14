/**
 * Tests for Auth/Users foundation — AuthService + UserRepository contracts:
 *   1. User creation and basic read
 *   2. Email uniqueness enforcement
 *   3. Password is never stored as plaintext
 *   4. Successful login returns SafeUser
 *   5. Wrong password returns null
 *   6. Disabled user is rejected even with correct password
 *
 * All tests use pure in-memory mocks — no real DB, no real bcrypt rounds
 * (BCRYPT_ROUNDS is overridden to 1 via env for speed; still exercises real hashing).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import bcrypt from 'bcrypt';
import type { Pool } from 'pg';
import { UserRepository } from '../src/modules/users/user.repository';
import { AuthService } from '../src/modules/users/auth.service';
import type { User } from '../src/modules/users/user.types';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'alice@example.com',
    password_hash: 'hashed',
    is_active: true,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...overrides,
  };
}

function makeMockPool(overrides: {
  queryResult?: { rows: User[]; rowCount: number };
} = {}): Pool {
  const result = overrides.queryResult ?? { rows: [], rowCount: 0 };
  return {
    query: vi.fn().mockResolvedValue(result),
    connect: vi.fn(),
  } as unknown as Pool;
}

// ─── UserRepository ───────────────────────────────────────────────────────────

describe('UserRepository — create and read', () => {
  it('create: inserts and returns the new user row', async () => {
    const stored = makeUser();
    const pool = makeMockPool({ queryResult: { rows: [stored], rowCount: 1 } });
    const repo = new UserRepository(pool);

    const result = await repo.create({ email: 'alice@example.com', password: 'HASHED' });

    expect(result.id).toBe(stored.id);
    expect(result.email).toBe(stored.email);
    expect(pool.query).toHaveBeenCalledOnce();
  });

  it('create: passes email and hash verbatim to the query', async () => {
    const stored = makeUser({ email: 'alice@example.com', password_hash: 'bcrypt-hash' });
    const pool = makeMockPool({ queryResult: { rows: [stored], rowCount: 1 } });
    const repo = new UserRepository(pool);

    await repo.create({ email: 'alice@example.com', password: 'bcrypt-hash' });

    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]];
    expect(sql).toContain('INSERT INTO users');
    // email is normalised to lower-case via LOWER($1) in SQL; params carry raw value
    expect(params[0]).toBe('alice@example.com');
    expect(params[1]).toBe('bcrypt-hash');
  });

  it('findByEmail: returns null when no row is found', async () => {
    const pool = makeMockPool({ queryResult: { rows: [], rowCount: 0 } });
    const repo = new UserRepository(pool);

    const result = await repo.findByEmail('nobody@example.com');

    expect(result).toBeNull();
  });

  it('findByEmail: returns user row when found', async () => {
    const stored = makeUser();
    const pool = makeMockPool({ queryResult: { rows: [stored], rowCount: 1 } });
    const repo = new UserRepository(pool);

    const result = await repo.findByEmail('alice@example.com');

    expect(result?.id).toBe(stored.id);
  });

  it('findById: returns null when no row is found', async () => {
    const pool = makeMockPool({ queryResult: { rows: [], rowCount: 0 } });
    const repo = new UserRepository(pool);

    expect(await repo.findById('00000000-0000-0000-0000-000000000099')).toBeNull();
  });

  it('findById: returns the user when found', async () => {
    const stored = makeUser();
    const pool = makeMockPool({ queryResult: { rows: [stored], rowCount: 1 } });
    const repo = new UserRepository(pool);

    const result = await repo.findById(stored.id);
    expect(result?.id).toBe(stored.id);
  });

  it('create: throws on duplicate email (propagates pg unique constraint error)', async () => {
    const pool = makeMockPool();
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' });
    (pool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(pgError);
    const repo = new UserRepository(pool);

    await expect(
      repo.create({ email: 'alice@example.com', password: 'hash' }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

// ─── AuthService — password hashing ──────────────────────────────────────────

describe('AuthService — password is never stored as plaintext', () => {
  it('register: password_hash stored in DB is a bcrypt hash, not plaintext', async () => {
    const plaintext = 'my-secret-password';
    let capturedHash = '';

    const pool = {
      query: vi.fn().mockImplementation(async (_sql: string, params: string[]) => {
        // params[1] is the value passed as password_hash
        capturedHash = params[1] as string;
        const row = makeUser({ password_hash: capturedHash });
        return { rows: [row], rowCount: 1 };
      }),
      connect: vi.fn(),
    } as unknown as Pool;

    const service = new AuthService(pool);
    await service.register({ email: 'alice@example.com', password: plaintext });

    // The captured hash must not equal the plaintext
    expect(capturedHash).not.toBe(plaintext);
    // It must be a valid bcrypt hash (starts with $2b$)
    expect(capturedHash).toMatch(/^\$2b\$/);
    // bcrypt.compare must verify it round-trips correctly
    expect(await bcrypt.compare(plaintext, capturedHash)).toBe(true);
  });

  it('register: returned SafeUser has no password_hash field', async () => {
    const pool = {
      query: vi.fn().mockImplementation(async (_sql: string, params: string[]) => {
        const row = makeUser({ password_hash: params[1] as string });
        return { rows: [row], rowCount: 1 };
      }),
      connect: vi.fn(),
    } as unknown as Pool;

    const service = new AuthService(pool);
    const result = await service.register({ email: 'alice@example.com', password: 'secret' });

    expect((result as Record<string, unknown>)['password_hash']).toBeUndefined();
  });
});

// ─── AuthService — authenticate ───────────────────────────────────────────────

describe('AuthService — authenticate', () => {
  const PLAINTEXT = 'correct-password';
  let REAL_HASH: string;

  beforeAll(async () => {
    // Use real bcrypt with 1 round for speed; still exercises the full code path
    REAL_HASH = await bcrypt.hash(PLAINTEXT, 1);
  });

  it('returns SafeUser on correct email + password', async () => {
    const stored = makeUser({ password_hash: REAL_HASH });
    const pool = makeMockPool({ queryResult: { rows: [stored], rowCount: 1 } });
    const service = new AuthService(pool);

    const result = await service.authenticate('alice@example.com', PLAINTEXT);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(stored.id);
    expect((result as Record<string, unknown>)['password_hash']).toBeUndefined();
  });

  it('returns null for wrong password', async () => {
    const stored = makeUser({ password_hash: REAL_HASH });
    const pool = makeMockPool({ queryResult: { rows: [stored], rowCount: 1 } });
    const service = new AuthService(pool);

    expect(await service.authenticate('alice@example.com', 'wrong-password')).toBeNull();
  });

  it('returns null for unknown email', async () => {
    const pool = makeMockPool({ queryResult: { rows: [], rowCount: 0 } });
    const service = new AuthService(pool);

    expect(await service.authenticate('ghost@example.com', PLAINTEXT)).toBeNull();
  });

  it('returns null for disabled user even with correct password', async () => {
    const stored = makeUser({ password_hash: REAL_HASH, is_active: false });
    const pool = makeMockPool({ queryResult: { rows: [stored], rowCount: 1 } });
    const service = new AuthService(pool);

    expect(await service.authenticate('alice@example.com', PLAINTEXT)).toBeNull();
  });

  it('authenticate: SafeUser returned on success has no password_hash', async () => {
    const stored = makeUser({ password_hash: REAL_HASH });
    const pool = makeMockPool({ queryResult: { rows: [stored], rowCount: 1 } });
    const service = new AuthService(pool);

    const result = await service.authenticate('alice@example.com', PLAINTEXT);
    expect((result as Record<string, unknown>)['password_hash']).toBeUndefined();
  });
});
