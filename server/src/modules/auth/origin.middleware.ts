import { NextFunction, Request, Response } from 'express';
import { normalizeAbsoluteOrigin, trustedPublicOrigins } from '../../config/public-origins';

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

  const normalizedOrigin = normalizeAbsoluteOrigin(origin);
  if (normalizedOrigin && trustedPublicOrigins(req).has(normalizedOrigin)) {
    next();
    return;
  }

  res.status(403).json({ error: 'Invalid request origin', code: 'INVALID_REQUEST_ORIGIN' });
}
