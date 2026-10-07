import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import pool from '../../db/pool';
import config from '../../config';
import { SessionService } from './session.service';
import { requireSameOrigin } from './origin.middleware';

const SESSION_COOKIE = 'eqfal_session';
const COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const authRouter = Router();

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function serviceOr503(res: Response): SessionService | null {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
    return null;
  }
  return new SessionService(pool);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) {
      try {
        return decodeURIComponent(rawValue.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    path: '/',
  });
}

authRouter.post('/auth/login', requireSameOrigin, asyncRoute(async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!email || email.length > 254 || !password || password.length > 256) {
    res.status(400).json({ error: 'Invalid login request', code: 'INVALID_LOGIN_REQUEST' });
    return;
  }

  const service = serviceOr503(res);
  if (!service) return;

  const result = await service.login(email, password);
  if (!result) {
    res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
    return;
  }

  const { token, ...context } = result;
  setSessionCookie(res, token);
  res.status(200).json(context);
}));

authRouter.get('/auth/session', asyncRoute(async (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }

  const service = serviceOr503(res);
  if (!service) return;

  const context = await service.getContext(token);
  if (!context) {
    clearSessionCookie(res);
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }

  res.status(200).json(context);
}));

authRouter.post('/auth/switch-company', requireSameOrigin, asyncRoute(async (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  const companyId = typeof req.body?.companyId === 'string' ? req.body.companyId : '';

  if (!token) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  if (!companyId) {
    res.status(400).json({ error: 'companyId is required' });
    return;
  }

  const service = serviceOr503(res);
  if (!service) return;

  const context = await service.switchCompany(token, companyId);
  if (context === null) {
    clearSessionCookie(res);
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  if (context === 'forbidden') {
    res.status(403).json({ error: 'Company access denied' });
    return;
  }

  res.status(200).json(context);
}));

authRouter.post('/auth/logout', requireSameOrigin, asyncRoute(async (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  clearSessionCookie(res);

  const service = serviceOr503(res);
  if (!service) return;

  if (token) await service.logout(token);
  res.status(204).end();
}));

export { readCookie, SESSION_COOKIE };
