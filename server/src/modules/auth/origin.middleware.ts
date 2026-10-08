import { NextFunction, Request, Response } from 'express';
import { normalizeAbsoluteOrigin, trustedPublicOrigins } from '../../config/public-origins';
import { SESSION_COOKIE } from './session-cookie';

function reject(res: Response, code: string, error: string): void {
  res.status(403).json({ error, code });
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** True when the request carries any cookie named like the session cookie (even an invalid one). */
function carriesSessionCookie(req: Request): boolean {
  const raw = req.headers.cookie;
  if (!raw) return false;
  return raw.split(';').some((part) => part.trim().split('=')[0] === SESSION_COOKIE);
}

/**
 * CSRF / cross-origin guard for state-changing endpoints that rely on the session cookie.
 *
 *  1. Origin present      -> must exactly match the trusted public-origin allowlist (strict, unchanged).
 *  2. Origin absent       -> evaluate the remaining browser evidence, rejecting anything cross-site:
 *       a. Sec-Fetch-Site must be same-origin or none (cross-site / same-site / unknown -> 403).
 *       b. Referer, when sent, must be an allowlisted origin (hostile, malformed or opaque -> 403).
 *       c. No usable evidence at all AND a session cookie is attached -> 403 (a browser always sends
 *          Origin on cross-site writes, so a cookie-bearing write with no evidence is not trusted).
 *       d. No evidence and no session cookie -> allowed (non-browser clients without ambient credentials,
 *          pre-login requests); protected routes still stop at authentication.
 *
 * Supported non-browser clients that keep a session cookie must send an allowlisted `Origin` header.
 */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const trusted = trustedPublicOrigins(req);
  const origin = req.headers.origin;

  if (origin !== undefined) {
    const normalized = typeof origin === 'string' ? normalizeAbsoluteOrigin(origin) : undefined;
    if (normalized && trusted.has(normalized)) {
      next();
      return;
    }
    reject(res, 'INVALID_REQUEST_ORIGIN', 'Invalid request origin');
    return;
  }

  const fetchSite = header(req, 'sec-fetch-site');
  if (fetchSite !== undefined) {
    const site = fetchSite.trim().toLowerCase();
    if (site !== 'same-origin' && site !== 'none') {
      reject(res, 'INVALID_REQUEST_ORIGIN', 'Invalid request origin');
      return;
    }
  }

  if (req.headers.referer !== undefined) {
    const referer = header(req, 'referer');
    let refererOrigin: string | undefined;
    try {
      refererOrigin = referer ? normalizeAbsoluteOrigin(new URL(referer).origin) : undefined;
    } catch {
      refererOrigin = undefined;
    }
    if (!refererOrigin || !trusted.has(refererOrigin)) {
      reject(res, 'INVALID_REQUEST_ORIGIN', 'Invalid request origin');
      return;
    }
    next();
    return;
  }

  if (fetchSite === undefined && carriesSessionCookie(req)) {
    reject(res, 'ORIGIN_REQUIRED', 'Request origin could not be verified');
    return;
  }
  next();
}
