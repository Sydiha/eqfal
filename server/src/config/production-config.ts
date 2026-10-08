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

const KNOWN_ENVIRONMENTS = new Set(['production', 'development', 'test']);
/** Variables that only a hosted/proxied deployment sets; their presence is "production intent". */
const PROXIED_PLATFORM_VARS = ['REPLIT_DEPLOYMENT', 'VERCEL', 'RENDER', 'FLY_APP_NAME', 'DYNO', 'K_SERVICE', 'RAILWAY_ENVIRONMENT'];
const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function behindProxiedPlatform(env: NodeJS.ProcessEnv): boolean {
  return PROXIED_PLATFORM_VARS.some((name) => (env[name] ?? '').trim() !== '');
}

/** TRUST_PROXY must be a hop count, `false`, Express keywords, or an IP/CIDR list (never trust-all). */
function isValidTrustProxy(raw: string): boolean {
  const value = raw.trim();
  if (/^\d+$/.test(value) || value.toLowerCase() === 'false') return true;
  return value.split(',').every((entry) => {
    const e = entry.trim().toLowerCase();
    return PROXY_KEYWORDS.has(e) || /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(e) || /^[0-9a-f]*:[0-9a-f:.]*(\/\d{1,3})?$/.test(e);
  });
}

function trustsNoProxy(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return !value || value === 'false' || /^0+$/.test(value);
}

/**
 * Returns a list of problems with the deployment environment. Pure (takes the env as input) and
 * deliberately independent of any hosting provider. Messages name variables only, never their values.
 *
 * Production intent is detected, not just NODE_ENV=production: a hosting-platform variable, a configured
 * public https origin or TRUST_PROXY with NODE_ENV unset/mistyped would otherwise silently boot with
 * insecure (non-Secure cookie, Host-derived origin) behaviour.
 */
export function validateProductionConfig(env: NodeJS.ProcessEnv): string[] {
  const nodeEnv = env['NODE_ENV'];
  const problems: string[] = [];

  if (nodeEnv !== 'production') {
    if (nodeEnv !== undefined && nodeEnv !== '' && !KNOWN_ENVIRONMENTS.has(nodeEnv)) {
      problems.push('NODE_ENV must be one of production, development or test');
    } else if (nodeEnv === undefined || nodeEnv === '') {
      const hasHttpsOrigin = (env['APP_PUBLIC_ORIGINS'] ?? '').split(',').some((s) => s.trim().toLowerCase().startsWith('https://'));
      if (hasHttpsOrigin || (env['TRUST_PROXY'] ?? '').trim() !== '' || behindProxiedPlatform(env)) {
        problems.push('NODE_ENV is not set but production settings are present (APP_PUBLIC_ORIGINS, TRUST_PROXY or a hosting-platform variable); set NODE_ENV=production, or NODE_ENV=development for local use');
      }
    }
    return problems;
  }

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
  } else if (trust && !isValidTrustProxy(trust)) {
    problems.push('TRUST_PROXY is invalid; use a hop count, false, loopback/linklocal/uniquelocal, or an IP/CIDR list');
  } else if (trustsNoProxy(trust) && behindProxiedPlatform(env)) {
    problems.push('A hosting-platform reverse proxy was detected but TRUST_PROXY trusts no proxy: every client would share one IP for login rate limiting. Set TRUST_PROXY to the number of proxy hops in front of the app');
  }

  return problems;
}

/** Non-fatal observations for operators (logged at startup). Same no-values rule as problems. */
export function productionConfigWarnings(env: NodeJS.ProcessEnv): string[] {
  if (env['NODE_ENV'] !== 'production') return [];
  const warnings: string[] = [];
  if (trustsNoProxy(env['TRUST_PROXY'])) {
    warnings.push('TRUST_PROXY trusts no proxy: if a reverse proxy terminates TLS in front of this app, all clients share one IP for login rate limiting. Set TRUST_PROXY to the proxy hop count in that case');
  }
  return warnings;
}

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = validateProductionConfig(env);
  if (problems.length > 0) {
    throw new Error(`Invalid production configuration:\n - ${problems.join('\n - ')}`);
  }
}
