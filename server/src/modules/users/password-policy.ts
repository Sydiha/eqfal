import crypto from 'crypto';

export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt only uses the first 72 bytes: longer passwords are refused instead of being silently truncated. */
export const MAX_PASSWORD_BYTES = 72;

export type PasswordPolicyViolation = 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | 'PASSWORD_SAME_AS_CURRENT' | 'PASSWORD_CONTAINS_EMAIL';

/** Server-side rules for a NEW password. Returns the first violated rule, or null when acceptable. */
export function validateNewPassword(password: string, context: { email: string; currentPassword?: string }): PasswordPolicyViolation | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'PASSWORD_TOO_SHORT';
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return 'PASSWORD_TOO_LONG';
  if (context.currentPassword !== undefined && password === context.currentPassword) return 'PASSWORD_SAME_AS_CURRENT';
  const local = context.email.split('@')[0]?.toLowerCase() ?? '';
  const lower = password.toLowerCase();
  if (lower === context.email.toLowerCase() || (local.length >= 4 && lower === local)) return 'PASSWORD_CONTAINS_EMAIL';
  return null;
}

// No 0/O/1/l/I: the administrator reads this out or copies it once.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Cryptographically random temporary password (16 chars, ~93 bits), unbiased via rejection sampling. */
export function generateTemporaryPassword(length = 16): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}
