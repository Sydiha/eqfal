import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { auditLogFacets, searchAuditLog, AuditLogFilters } from './audit-log.query';

/**
 * Audit Log viewer. Strictly read-only: only GET routes exist (no create/update/delete),
 * and every query is bound to the session's active company, never to a client-supplied one.
 */
export const auditLogRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
const guards = [requireAuth, requireActiveCompany, requireCapability('audit.view')];
const BAD = { error: 'Invalid audit log request' };
const MAX_LIMIT = 100;

function single(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length <= max ? trimmed : null;
}
function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

function parseFilters(query: Request['query']): AuditLogFilters | null {
  const q = single(query.q, 200), action = single(query.action, 100), entityType = single(query.entity_type, 100);
  const entityId = single(query.entity_id, 36), actor = single(query.actor_user_id, 36);
  const from = single(query.from, 10), to = single(query.to, 10);
  if ([q, action, entityType, entityId, actor, from, to].some((v) => v === null)) return null;
  if ((entityId && !UUID.test(entityId)) || (actor && !UUID.test(actor))) return null;
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) return null;
  const limitRaw = single(query.limit, 4), offsetRaw = single(query.offset, 9);
  if (limitRaw === null || offsetRaw === null) return null;
  const limit = limitRaw === undefined ? 50 : /^\d+$/.test(limitRaw) ? Number(limitRaw) : NaN;
  const offset = offsetRaw === undefined ? 0 : /^\d+$/.test(offsetRaw) ? Number(offsetRaw) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isInteger(offset)) return null;
  return { q: q ?? undefined, action: action ?? undefined, entity_type: entityType ?? undefined, entity_id: entityId ?? undefined, actor_user_id: actor ?? undefined, from: from ?? undefined, to: to ?? undefined, limit, offset };
}

auditLogRouter.get('/audit-log', ...guards, asyncRoute(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const filters = parseFilters(req.query);
  if (!filters) { res.status(400).json(BAD); return; }
  const companyId = getAuthenticatedContext(req)!.activeCompanyId!;
  const result = await searchAuditLog(pool, companyId, filters);
  res.json({ ...result, limit: filters.limit, offset: filters.offset });
}));

auditLogRouter.get('/audit-log/facets', ...guards, asyncRoute(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  res.json(await auditLogFacets(pool, getAuthenticatedContext(req)!.activeCompanyId!));
}));
