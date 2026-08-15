import { NextFunction, Request, Response, Router } from 'express';
import pool from '../../db/pool';
import {
  getAuthenticatedContext,
  requireActiveCompany,
  requireAuth,
  requireCapability,
} from '../auth/auth.middleware';
import { AuthSessionContext } from '../auth/session.service';
import { FiscalYearRepository } from './fiscal-year.repository';
import { FiscalYearService } from './fiscal-year.service';
import { UpdateFiscalYearInput } from './fiscal-year.types';

export const fiscalYearRouter = Router();

const VIEW_CAPABILITY = 'fiscal_year.view';
const MANAGE_CAPABILITY = 'fiscal_year.manage';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type ActiveAuthContext = AuthSessionContext & { activeCompanyId: string };

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };
}

function serviceOr503(res: Response): FiscalYearService | null {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable' });
    return null;
  }
  return new FiscalYearService(pool);
}

function repositoryOr503(res: Response): FiscalYearRepository | null {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable' });
    return null;
  }
  return new FiscalYearRepository(pool);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(body).every((key) => set.has(key));
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
  );
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 120) return null;
  return name;
}

function activeContext(req: Request, res: Response): ActiveAuthContext | null {
  const context = getAuthenticatedContext(req);
  if (!context?.activeCompanyId) {
    res.status(403).json({ error: 'No active company' });
    return null;
  }
  return context as ActiveAuthContext;
}

function mapDomainError(err: unknown, res: Response, next: NextFunction): void {
  if (!(err instanceof Error)) {
    next(err);
    return;
  }

  if (err.message.includes('not found or access denied')) {
    res.status(404).json({ error: 'Fiscal year not found' });
    return;
  }

  if (err.message.startsWith('Invalid date range:')) {
    res.status(400).json({ error: 'Invalid fiscal year date range' });
    return;
  }

  if (
    err.message.startsWith('Fiscal year overlap:') ||
    err.message.includes('is already closed') ||
    err.message.includes('is closed and cannot be modified')
  ) {
    res.status(409).json({ error: 'Fiscal year state conflict' });
    return;
  }

  next(err);
}

fiscalYearRouter.get(
  '/fiscal-years',
  requireAuth,
  requireActiveCompany,
  requireCapability(VIEW_CAPABILITY),
  asyncRoute(async (req, res) => {
    const context = activeContext(req, res);
    if (!context) return;
    const repository = repositoryOr503(res);
    if (!repository) return;

    const fiscalYears = await repository.findByCompany(context.activeCompanyId);
    res.status(200).json({ fiscalYears });
  }),
);

fiscalYearRouter.post(
  '/fiscal-years',
  requireAuth,
  requireActiveCompany,
  requireCapability(MANAGE_CAPABILITY),
  asyncRoute(async (req, res, next) => {
    if (!isPlainObject(req.body) || !hasOnlyKeys(req.body, ['name', 'start_date', 'end_date'])) {
      res.status(400).json({ error: 'Invalid fiscal year request' });
      return;
    }

    const name = normalizeName(req.body.name);
    if (!name || !isIsoDate(req.body.start_date) || !isIsoDate(req.body.end_date)) {
      res.status(400).json({ error: 'Invalid fiscal year request' });
      return;
    }

    const context = activeContext(req, res);
    if (!context) return;
    const service = serviceOr503(res);
    if (!service) return;

    try {
      const fiscalYear = await service.createFiscalYear(
        {
          company_id: context.activeCompanyId,
          name,
          start_date: req.body.start_date,
          end_date: req.body.end_date,
        },
        context.user.id,
      );
      res.status(201).json({ fiscalYear });
    } catch (err) {
      mapDomainError(err, res, next);
    }
  }),
);

fiscalYearRouter.patch(
  '/fiscal-years/:id',
  requireAuth,
  requireActiveCompany,
  requireCapability(MANAGE_CAPABILITY),
  asyncRoute(async (req, res, next) => {
    if (!isPlainObject(req.body) || !hasOnlyKeys(req.body, ['name', 'start_date', 'end_date'])) {
      res.status(400).json({ error: 'Invalid fiscal year request' });
      return;
    }

    const input: UpdateFiscalYearInput = {};
    if (req.body.name !== undefined) {
      const name = normalizeName(req.body.name);
      if (!name) {
        res.status(400).json({ error: 'Invalid fiscal year request' });
        return;
      }
      input.name = name;
    }
    if (req.body.start_date !== undefined) {
      if (!isIsoDate(req.body.start_date)) {
        res.status(400).json({ error: 'Invalid fiscal year request' });
        return;
      }
      input.start_date = req.body.start_date;
    }
    if (req.body.end_date !== undefined) {
      if (!isIsoDate(req.body.end_date)) {
        res.status(400).json({ error: 'Invalid fiscal year request' });
        return;
      }
      input.end_date = req.body.end_date;
    }
    if (Object.keys(input).length === 0) {
      res.status(400).json({ error: 'No fiscal year fields supplied' });
      return;
    }

    const context = activeContext(req, res);
    if (!context) return;
    const service = serviceOr503(res);
    if (!service) return;

    try {
      const fiscalYear = await service.updateFiscalYear(
        req.params.id,
        context.activeCompanyId,
        input,
        context.user.id,
      );
      res.status(200).json({ fiscalYear });
    } catch (err) {
      mapDomainError(err, res, next);
    }
  }),
);

fiscalYearRouter.post(
  '/fiscal-years/:id/close',
  requireAuth,
  requireActiveCompany,
  requireCapability(MANAGE_CAPABILITY),
  asyncRoute(async (req, res, next) => {
    const body = req.body === undefined ? {} : req.body;
    if (!isPlainObject(body) || !hasOnlyKeys(body, ['reason'])) {
      res.status(400).json({ error: 'Invalid close request' });
      return;
    }

    let reason: string | undefined;
    if (body.reason !== undefined) {
      if (typeof body.reason !== 'string' || body.reason.trim().length > 500) {
        res.status(400).json({ error: 'Invalid close request' });
        return;
      }
      reason = body.reason.trim() || undefined;
    }

    const context = activeContext(req, res);
    if (!context) return;
    const service = serviceOr503(res);
    if (!service) return;

    try {
      const fiscalYear = await service.closeFiscalYear(
        req.params.id,
        context.activeCompanyId,
        context.user.id,
        reason,
      );
      res.status(200).json({ fiscalYear });
    } catch (err) {
      mapDomainError(err, res, next);
    }
  }),
);
