/** Authorization-policy failure with a stable, non-revealing code (no capability names). */
export class AccessPolicyError extends Error {
  constructor(message: string, readonly code: 'ACCESS_ROLE_CEILING' | 'ACCESS_FULL_ACCESS_IMMUTABLE') { super(message); }
}
