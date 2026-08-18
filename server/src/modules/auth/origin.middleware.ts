import { NextFunction, Request, Response } from 'express';

function normalizeHost(value: string, protocol: string): string | undefined {
  try {
    const url = new URL(`${protocol}//${value}`);
    if (
      !url.host ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.host;
  } catch {
    return undefined;
  }
}

/**
 * Reject cross-origin browser requests for state-changing endpoints that rely
 * on the session cookie. Requests without an Origin header are allowed so
 * same-origin/non-browser clients and tests are not broken unnecessarily.
 */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (!origin) {
    next();
    return;
  }

  try {
    const originUrl = new URL(origin);
    const trustedHosts = [req.headers['x-forwarded-host'], req.headers.host]
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .flatMap((value) => (value ?? '').split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && !/\s/.test(value))
      .map((value) => normalizeHost(value, originUrl.protocol))
      .filter((value): value is string => value !== undefined);

    if (trustedHosts.includes(originUrl.host)) {
      next();
      return;
    }
  } catch {
    // fall through to rejection
  }

  res.status(403).json({ error: 'Invalid request origin' });
}
