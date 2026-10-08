/**
 * In-memory login throttling (no external/paid service). Three fixed-window buckets are charged per attempt
 * BEFORE the password is checked (so parallel bursts cannot overshoot and blocked requests never reach bcrypt):
 *   - IP            : credential stuffing / bcrypt exhaustion from one client
 *   - email + IP    : brute force against one account from one client (lockout only affects that client)
 *   - email         : distributed guessing against one account (higher bar, so one attacker cannot cheaply lock a victim out)
 * A successful login refunds its charges. State is per Node process: with several instances behind a balancer the
 * effective limit is multiplied by the instance count.
 */
export interface LoginRateLimitOptions {
  windowMs: number;
  maxPerIp: number;
  maxPerEmailIp: number;
  maxPerEmail: number;
  maxEntries: number;
}

export type LoginAttempt =
  | { allowed: true; release: (success: boolean) => void }
  | { allowed: false; retryAfterSeconds: number };

const DEFAULTS: LoginRateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  maxPerIp: 30,
  maxPerEmailIp: 5,
  maxPerEmail: 20,
  maxEntries: 10_000,
};

interface Bucket { count: number; resetAt: number }

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly options: LoginRateLimitOptions;

  constructor(options: Partial<LoginRateLimitOptions> = {}, private readonly now: () => number = Date.now) {
    this.options = { ...DEFAULTS, ...options };
  }

  reserve(ip: string, email: string): LoginAttempt {
    const normalizedEmail = email.trim().toLowerCase();
    const keys: Array<[string, number]> = [
      [`ip:${ip}`, this.options.maxPerIp],
      [`pair:${ip}|${normalizedEmail}`, this.options.maxPerEmailIp],
      [`email:${normalizedEmail}`, this.options.maxPerEmail],
    ];
    const now = this.now();
    this.pruneExpired(now);

    let retryAt = 0;
    let newKeys = 0;
    for (const [key, max] of keys) {
      const bucket = this.buckets.get(key);
      if (!bucket) { newKeys += 1; continue; }
      if (bucket.count >= max) retryAt = Math.max(retryAt, bucket.resetAt);
    }
    // Bounded memory, fail closed: never evict live buckets (that would let key flooding reset lockouts).
    // When full, only attempts that need NEW buckets are refused, until the earliest bucket expires.
    if (retryAt === 0 && this.buckets.size + newKeys > this.options.maxEntries) retryAt = this.earliestReset();
    if (retryAt > 0) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)) };

    const charged = keys.map(([key]) => {
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = { count: 0, resetAt: now + this.options.windowMs };
        this.buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket;
    });
    return {
      allowed: true,
      release: (success: boolean) => {
        if (!success) return;
        for (const bucket of charged) bucket.count = Math.max(0, bucket.count - 1);
        charged[1]!.count = 0; // a correct password clears this client's failures for the account
      },
    };
  }

  size(): number { return this.buckets.size; }
  reset(): void { this.buckets.clear(); }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }

  private earliestReset(): number {
    let earliest = Infinity;
    for (const bucket of this.buckets.values()) earliest = Math.min(earliest, bucket.resetAt);
    return earliest === Infinity ? this.now() + this.options.windowMs : earliest;
  }
}

export const loginRateLimiter = new LoginRateLimiter();

/** TRUST_PROXY: unset/false → trust nothing; "true" → trust all hops (only behind a proxy that overwrites X-Forwarded-For); number → hop count; other → Express subnet list. */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = (raw ?? '').trim();
  if (!value || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
