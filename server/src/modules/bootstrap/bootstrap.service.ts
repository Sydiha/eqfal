import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { CompanyManagementService } from '../companies/company.service';
import { UserRepository } from '../users/user.repository';

const BCRYPT_ROUNDS = 12;
/** Arbitrary but fixed key serialising initial bootstraps ("eqfal bootstrap"); do not change. */
const BOOTSTRAP_LOCK_KEY = 7_432_092;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_BYTES = 72; // bcrypt silently ignores bytes beyond 72

export type BootstrapErrorCode = 'INVALID_INPUT' | 'ALREADY_INITIALIZED';

export class BootstrapError extends Error {
  constructor(readonly code: BootstrapErrorCode, message: string) { super(message); }
}

export interface BootstrapInput {
  email: string;
  password: string;
  company: { slug: string; name: string; name_ar: string | null };
}

export interface BootstrapResult { userId: string; companyId: string; email: string; slug: string }

export function validateBootstrapInput(input: BootstrapInput): void {
  const email = input.email.trim();
  if (!email || email.length > 254 || !EMAIL.test(email)) throw new BootstrapError('INVALID_INPUT', 'Invalid administrator email.');
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new BootstrapError('INVALID_INPUT', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) throw new BootstrapError('INVALID_INPUT', `Password must be at most ${MAX_PASSWORD_BYTES} bytes.`);
  const { slug, name, name_ar } = input.company;
  if (!slug || slug.length > 64 || !SLUG.test(slug)) throw new BootstrapError('INVALID_INPUT', 'Invalid company slug (lowercase letters, digits, hyphens).');
  if (!name.trim() || name.length > 200) throw new BootstrapError('INVALID_INPUT', 'Invalid company name.');
  if (name_ar !== null && name_ar.length > 200) throw new BootstrapError('INVALID_INPUT', 'Invalid Arabic company name.');
}

/**
 * Creates the very first user and company on an EMPTY database, in one transaction.
 * Fails closed (ALREADY_INITIALIZED, nothing written) if any user or company exists.
 * Concurrent runs are serialised by an advisory lock plus a SHARE ROW EXCLUSIVE table lock
 * on users/companies, so exactly one can succeed. Existing rows are never modified or deleted.
 * Company, default roles, Full Access membership and the company.create audit entry come from
 * CompanyManagementService.createWithClient (the established workflow). The password is only
 * ever passed to bcrypt; it is never logged or written to the audit trail.
 */
export async function bootstrapInitialAdmin(pool: Pool, input: BootstrapInput): Promise<BootstrapResult> {
  validateBootstrapInput(input);
  const email = input.email.trim();
  const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);
    await client.query('LOCK TABLE users, companies IN SHARE ROW EXCLUSIVE MODE');
    const { rows } = await client.query<{ users: boolean; companies: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM users) AS users, EXISTS (SELECT 1 FROM companies) AS companies',
    );
    if (rows[0]?.users || rows[0]?.companies) {
      throw new BootstrapError('ALREADY_INITIALIZED', 'Database already contains users or companies; bootstrap refused.');
    }
    const user = await new UserRepository(pool).create({ email, password: hash }, client);
    const company = await new CompanyManagementService(pool).createWithClient(client, input.company, user.id);
    await new AuditLogRepository().logEvent({
      company_id: company.id, actor_user_id: user.id, action: 'bootstrap.initialize', entity_type: 'user', entity_id: user.id,
      before_data: null, after_data: { email: user.email, company_slug: company.slug },
    }, client);
    await client.query('COMMIT');
    return { userId: user.id, companyId: company.id, email: user.email, slug: company.slug };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
