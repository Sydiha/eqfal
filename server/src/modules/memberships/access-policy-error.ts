/** Authorization-policy failure with a stable, non-revealing code (no capability names). */
export class AccessPolicyError extends Error {
  constructor(message: string, readonly code: 'ACCESS_ROLE_CEILING' | 'ACCESS_FULL_ACCESS_IMMUTABLE' | 'ACCESS_TARGET_PRIVILEGE' | 'ACCESS_LAST_FULL_ACCESS'
  | 'ACCESS_LAST_SYSTEM_ADMIN' | 'ACCESS_SELF_LOCKOUT' | 'ACCESS_SYSTEM_ADMIN_REQUIRED' | 'ACCESS_TARGET_INACTIVE' | 'ACCESS_COMPANY_INACTIVE') { super(message); }
}
