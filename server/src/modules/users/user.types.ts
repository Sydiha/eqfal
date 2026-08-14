/**
 * User — row shape as returned from the DB.
 * password_hash is intentionally included here for internal use only.
 * Public-facing code must use SafeUser which strips it.
 */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * SafeUser — user shape with password_hash removed.
 * This is the type returned to callers outside the auth layer.
 */
export type SafeUser = Omit<User, 'password_hash'>;

export interface CreateUserInput {
  email: string;
  /** Plaintext password — will be hashed before storage. */
  password: string;
}
