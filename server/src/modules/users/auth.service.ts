import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { UserRepository } from './user.repository';
import { SafeUser, CreateUserInput } from './user.types';
import logger from '../../shared/logger';

const BCRYPT_ROUNDS = 12;

/**
 * A pre-computed valid bcrypt hash (cost 12) of a fixed internal string.
 * Used as the target for dummy bcrypt.compare when a login email is not found,
 * so the branch takes approximately the same time as a real comparison and
 * does not leak user existence via timing.
 *
 * Must be a genuine bcrypt hash — an invalid/malformed string causes bcrypt to
 * reject it immediately without doing full work, defeating the protection.
 * Regenerate with: bcrypt.hash('__eqfal_dummy__', 12)
 */
const DUMMY_HASH =
  '$2b$12$ALje4sFzRE6RMsjnfdrdv.4Hgp0PaH.sllncbFv3SLSLozeehjm2S';

/**
 * Strips password_hash before returning user data to callers.
 */
function toSafeUser(row: { id: string; email: string; password_hash: string; is_active: boolean; created_at: Date; updated_at: Date }): SafeUser {
  const { password_hash: _ph, ...safe } = row;
  return safe;
}

/**
 * AuthService
 *
 * Owns all password hashing and verification logic.
 * Never returns password_hash to callers — always strips it via SafeUser.
 *
 * Portable: no Replit-specific dependencies. Works in any Node environment.
 */
export class AuthService {
  private readonly repo: UserRepository;

  constructor(pool: Pool) {
    this.repo = new UserRepository(pool);
  }

  /**
   * Register a new user.
   * Hashes the plaintext password with bcrypt before persisting.
   * Returns SafeUser (no password_hash).
   * Throws if email is already taken (pg unique constraint).
   */
  async register(input: CreateUserInput): Promise<SafeUser> {
    const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const user = await this.repo.create({ email: input.email, password: hash });
    logger.info({ userId: user.id }, 'User registered');
    return toSafeUser(user);
  }

  /**
   * Authenticate a user by email + plaintext password.
   * Returns SafeUser on success, null on any failure (wrong password,
   * unknown email, or disabled account).
   *
   * Disabled users (is_active = false) are rejected even with a correct password.
   * Uses bcrypt.compare — constant-time, safe against timing attacks.
   */
  async authenticate(email: string, password: string): Promise<SafeUser | null> {
    const user = await this.repo.findByEmail(email);

    if (!user) {
      // Constant-time guard: compare against a real bcrypt hash so the branch
      // takes the same time as a known-email path. An invalid/malformed dummy
      // would be rejected immediately by bcrypt, leaking existence via timing.
      await bcrypt.compare(password, DUMMY_HASH);
      return null;
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return null;
    }

    if (!user.is_active) {
      logger.warn({ userId: user.id }, 'Disabled user attempted authentication');
      return null;
    }

    return toSafeUser(user);
  }
}
