import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { MembershipService } from './membership.service';

export const accessAdministrationRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const CAPABILITY = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);

const readGuards = [requireAuth, requireActiveCompany, requireCapability('access.view')];
const writeGuards = (capability: string): RequestHandler[] => [
  requireSameOrigin,
  requireAuth,
  requireActiveCompany,
  requireCapability(capability),
];

function context(req: Request) {
  return getAuthenticatedContext(req)! as NonNullable<ReturnType<typeof getAuthenticatedContext>> & { activeCompanyId: string };
}

function service(res: Response): MembershipService | null {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable' });
    return null;
  }
  return new MembershipService(pool);
}

function exactObject(body: unknown, keys: string[]): body is Record<string, unknown> {
  return !!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));
}

function handleKnownError(error: unknown, res: Response): boolean {
  const message = error instanceof Error ? error.message : '';
  if (/not found/i.test(message)) res.status(404).json({ error: 'Not found' });
  else if (/cross-company|ceiling|full access|cannot be changed/i.test(message)) res.status(403).json({ error: 'Forbidden' });
  else if ((error as { code?: string }).code === '23505') res.status(409).json({ error: 'Conflict' });
  else if ((error as { code?: string }).code?.startsWith('23')) res.status(400).json({ error: 'Invalid access administration request' });
  else return false;
  return true;
}

accessAdministrationRouter.get('/access/memberships', ...readGuards, asyncRoute(async (req, res) => {
  const value = service(res);
  if (value) res.json({ memberships: await value.listMemberships(context(req).activeCompanyId) });
}));

accessAdministrationRouter.get('/access/roles', ...readGuards, asyncRoute(async (req, res) => {
  const value = service(res);
  if (value) res.json({ roles: await value.listRoles(context(req).activeCompanyId) });
}));

accessAdministrationRouter.post('/access/memberships', ...writeGuards('access.membership.create'), asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  if (!exactObject(req.body, ['user_id']) || typeof req.body.user_id !== 'string' || !UUID.test(req.body.user_id)) {
    res.status(400).json({ error: 'Invalid access administration request' }); return;
  }
  const ctx = context(req);
  try { res.status(201).json(await value.createMembershipForCompany(req.body.user_id, ctx.activeCompanyId, ctx.user.id)); }
  catch (error) { if (!handleKnownError(error, res)) throw error; }
}));

accessAdministrationRouter.patch('/access/memberships/:id/active', ...writeGuards('access.membership.status.edit'), asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  if (!UUID.test(req.params.id) || !exactObject(req.body, ['is_active']) || typeof req.body.is_active !== 'boolean') {
    res.status(400).json({ error: 'Invalid access administration request' }); return;
  }
  const ctx = context(req);
  try { res.json(await value.setMembershipActive(req.params.id, ctx.activeCompanyId, req.body.is_active, ctx.user.id)); }
  catch (error) { if (!handleKnownError(error, res)) throw error; }
}));

accessAdministrationRouter.post('/access/roles', ...writeGuards('access.role.create'), asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  const name = exactObject(req.body, ['name']) && typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 100) { res.status(400).json({ error: 'Invalid access administration request' }); return; }
  const ctx = context(req);
  try { res.status(201).json(await value.createRoleForCompany(name, ctx.activeCompanyId, ctx.user.id)); }
  catch (error) { if (!handleKnownError(error, res)) throw error; }
}));

accessAdministrationRouter.put('/access/memberships/:id/role', ...writeGuards('access.membership.role.assign'), asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  if (!UUID.test(req.params.id) || !exactObject(req.body, ['role_id']) || typeof req.body.role_id !== 'string' || !UUID.test(req.body.role_id)) {
    res.status(400).json({ error: 'Invalid access administration request' }); return;
  }
  const ctx = context(req);
  try { res.json(await value.assignRoleForCompany(req.params.id, req.body.role_id, ctx.activeCompanyId, ctx.user.id)); }
  catch (error) { if (!handleKnownError(error, res)) throw error; }
}));

async function capabilityChange(req: Request, res: Response, add: boolean): Promise<void> {
  const value = service(res);
  if (!value) return;
  const { id, capabilityId } = req.params;
  if (!UUID.test(id) || !CAPABILITY.test(capabilityId)) { res.status(400).json({ error: 'Invalid access administration request' }); return; }
  const ctx = context(req);
  try { await value.changeRoleCapability(id, capabilityId, ctx.activeCompanyId, ctx.user.id, add); res.status(204).end(); }
  catch (error) { if (!handleKnownError(error, res)) throw error; }
}

accessAdministrationRouter.put(
  '/access/roles/:id/capabilities/:capabilityId',
  ...writeGuards('access.role.capability.grant'),
  asyncRoute((req, res) => capabilityChange(req, res, true)),
);
accessAdministrationRouter.delete(
  '/access/roles/:id/capabilities/:capabilityId',
  ...writeGuards('access.role.capability.revoke'),
  asyncRoute((req, res) => capabilityChange(req, res, false)),
);
