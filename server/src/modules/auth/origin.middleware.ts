import { NextFunction, Request, Response } from 'express';

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

  const expectedHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
    .split(',')[0]
    ?.trim();

  try {
    if (expectedHost && new URL(origin).host === expectedHost) {
      next();
      return;
    }
  } catch {
    // fall through to rejection
  }

  res.status(403).json({ error: 'Invalid request origin' });
}
