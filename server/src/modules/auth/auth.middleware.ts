import { Request, Response, NextFunction } from 'express';
import pool from '../../db/pool';
import { readCookie, SESSION_COOKIE } from './auth.router';
import { AuthSessionContext, SessionService } from './session.service';

const AUTH_CONTEXT = Symbol('eqfal.authContext');

type RequestWithAuth = Request & { [AUTH_CONTEXT]?: AuthSessionContext };

export function getAuthenticatedContext(req: Request): AuthSessionContext | null {
  return (req as RequestWithAuth)[AUTH_CONTEXT] ?? null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable' });
    return;
  }

  const token = readCookie(req, SESSION_COOKIE);
  if (!token) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }

  const context = await new SessionService(pool).getContext(token);
  if (!context) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }

  (req as RequestWithAuth)[AUTH_CONTEXT] = context;
  next();
}

export function requireActiveCompany(req: Request, res: Response, next: NextFunction): void {
  const context = getAuthenticatedContext(req);
  if (!context) {
    res.status(401).json({ error: 'Unauthenticated' });
    return;
  }
  if (!context.activeCompanyId) {
    res.status(403).json({ error: 'No active company' });
    return;
  }
  next();
}

export function requireCapability(capability: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const context = getAuthenticatedContext(req);
    if (!context) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    if (!context.activeCompanyId || !context.capabilities.includes(capability)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
