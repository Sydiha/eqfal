import { Pool, PoolClient } from 'pg';
import { User, CreateUserInput } from './user.types';

type QueryRunner = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/**
 * UserRepository
 *
 * Handles persistence for the users table.
 * Callers are responsible for hashing passwords before calling `create`.
 * This repository never hashes or reads plaintext passwords.
 */
export class UserRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Persist a new user row.
   * `input.password` must already be a bcrypt hash — the repository stores
   * it verbatim in `password_hash`.
   * Throws on duplicate email (unique constraint violation → pg code 23505).
   */
  async create(
    input: CreateUserInput,
    client?: PoolClient,
  ): Promise<User> {
    const runner: QueryRunner = client ?? this.pool;
    const { rows } = await runner.query<User>(
      `INSERT INTO users (email, password_hash)
       VALUES (LOWER($1), $2)
       RETURNING *`,
      [input.email, input.password],
    );
    return rows[0] as User;
  }

  /**
   * Look up a user by email (case-insensitive).
   * Returns the full User row including password_hash for auth verification.
   * Do not expose this row directly to API responses — strip password_hash first.
   */
  async findByEmail(email: string): Promise<User | null> {
    const { rows } = await this.pool.query<User>(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
      [email],
    );
    return rows[0] ?? null;
  }

  /**
   * Look up a user by primary key.
   * Returns the full User row including password_hash.
   */
  async findById(id: string): Promise<User | null> {
    const { rows } = await this.pool.query<User>(
      'SELECT * FROM users WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  /** Stores a new bcrypt hash. `mustChange` is TRUE only for administrative (temporary) passwords. */
  async setPassword(userId: string, passwordHash: string, mustChange: boolean, client?: PoolClient): Promise<void> {
    const runner: QueryRunner = client ?? this.pool;
    await runner.query(
      `UPDATE users
       SET password_hash = $2, must_change_password = $3, password_changed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [userId, passwordHash, mustChange],
    );
  }
}
