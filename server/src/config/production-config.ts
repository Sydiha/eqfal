import { normalizeAbsoluteOrigin } from './public-origins';

/** TRUST_PROXY values that would make Express trust any client-supplied X-Forwarded-* header. */
function isTrustAll(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '*') return true;
  return value.split(',').some((entry) => {
    const e = entry.trim();
    return e === '0.0.0.0/0' || e === '::/0';
  });
}

/**
 * Returns a list of problems with the production environment. Pure (takes the env as input) and
 * deliberately independent of any hosting provider: no Replit-specific variable is required.
 * Messages name variables only, never their values.
 */
export function validateProductionConfig(env: NodeJS.ProcessEnv): string[] {
  if (env['NODE_ENV'] !== 'production') return [];
  const problems: string[] = [];

  if (!env['DATABASE_URL']?.trim()) problems.push('DATABASE_URL is required in production');

  const origins = (env['APP_PUBLIC_ORIGINS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length === 0) {
    problems.push('APP_PUBLIC_ORIGINS is required in production (comma-separated https origins used for CSRF origin checks)');
  }
  for (const entry of origins) {
    const origin = normalizeAbsoluteOrigin(entry);
    if (!origin) problems.push('APP_PUBLIC_ORIGINS contains an invalid origin (expected e.g. https://app.example.com)');
    else if (!origin.startsWith('https://')) problems.push('APP_PUBLIC_ORIGINS must use https in production');
  }

  const trust = env['TRUST_PROXY'];
  if (trust && isTrustAll(trust)) {
    problems.push('TRUST_PROXY must not trust every proxy in production; use a hop count (e.g. 1) or the proxy subnet');
  }

  return problems;
}

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = validateProductionConfig(env);
  if (problems.length > 0) {
    throw new Error(`Invalid production configuration:\n - ${problems.join('\n - ')}`);
  }
}
