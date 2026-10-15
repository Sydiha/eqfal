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
  /** Global System Admin marker (migration 075). Optional so older fixtures without the column stay valid. */
  is_system_admin?: boolean;
  /** Migration 082. Optional so older fixtures without the column stay valid. */
  must_change_password?: boolean;
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
  /** Administratively chosen initial password: the user must replace it at first login (migration 082). */
  mustChangePassword?: boolean;
}
