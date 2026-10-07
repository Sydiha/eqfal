import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { AccessPolicyError } from './access-policy-error';
import { MembershipService } from './membership.service';

export const accessAdministrationRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
    res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });
    return null;
  }
  return new MembershipService(pool);
}

function exactObject(body: unknown, keys: string[]): body is Record<string, unknown> {
  return !!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));
}

function handleKnownError(error: unknown, res: Response): boolean {
  const message = error instanceof Error ? error.message : '';
  if (error instanceof AccessPolicyError) { res.status(403).json({ error: 'Forbidden', code: error.code }); return true; }
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

accessAdministrationRouter.get('/access/capabilities', ...readGuards, asyncRoute(async (_req, res) => {
  const value = service(res);
  if (value) res.json({ capabilities: await value.listCapabilities() });
}));

accessAdministrationRouter.post('/access/memberships', ...writeGuards('access.membership.create'), asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  const body = req.body as Record<string, unknown>;
  const byId = exactObject(body, ['user_id']) && typeof body.user_id === 'string' && UUID.test(body.user_id);
  const email = exactObject(body, ['email']) && typeof body.email === 'string' ? body.email.trim() : '';
  const byEmail = email.length > 0 && email.length <= 254 && EMAIL.test(email);
  if (!byId && !byEmail) {
    res.status(400).json({ error: 'Invalid access administration request' }); return;
  }
  const ctx = context(req);
  try {
    const membership = byId
      ? await value.createMembershipForCompany(body.user_id as string, ctx.activeCompanyId, ctx.user.id)
      : await value.createMembershipByEmail(email, ctx.activeCompanyId, ctx.user.id);
    res.status(201).json(membership);
  }
  catch (error) { if (!handleKnownError(error, res)) throw error; }
}));

const MIN_PASSWORD = 8;
accessAdministrationRouter.post('/access/users', ...writeGuards('access.membership.create'), asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  const body = req.body as Record<string, unknown>;
  const email = exactObject(body, ['email', 'password', 'role_id']) && typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const roleId = body?.role_id === undefined || body.role_id === null || body.role_id === '' ? null : body.role_id;
  const valid = email.length > 0 && email.length <= 254 && EMAIL.test(email)
    && password.length >= MIN_PASSWORD && password.length <= 256
    && (roleId === null || (typeof roleId === 'string' && UUID.test(roleId)));
  if (!valid) { res.status(400).json({ error: 'Invalid access administration request' }); return; }
  const ctx = context(req);
  if (roleId !== null && !ctx.capabilities.includes('access.membership.role.assign')) {
    res.status(403).json({ error: 'Forbidden' }); return;
  }
  try { res.status(201).json(await value.createUserForCompany(email, password, roleId as string | null, ctx.activeCompanyId, ctx.user.id)); }
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

const MAX_BULK = 500;
const capabilityList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length <= MAX_BULK && value.every((id) => typeof id === 'string' && CAPABILITY.test(id)) ? [...new Set(value as string[])] : null;

/** One atomic request for Select all / Clear all / group toggles. Needs grant and/or revoke depending on what is requested. */
accessAdministrationRouter.post(
  '/access/roles/:id/capabilities/bulk',
  requireSameOrigin, requireAuth, requireActiveCompany,
  asyncRoute(async (req, res) => {
    const value = service(res);
    if (!value) return;
    const ctx = context(req);
    const body = req.body as Record<string, unknown>;
    const grants = exactObject(body, ['grants', 'revokes']) ? capabilityList(body.grants ?? []) : null;
    const revokes = exactObject(body, ['grants', 'revokes']) ? capabilityList(body.revokes ?? []) : null;
    if (!UUID.test(req.params.id) || !grants || !revokes || grants.length + revokes.length === 0 || grants.some((id) => revokes.includes(id))) {
      res.status(400).json({ error: 'Invalid access administration request' }); return;
    }
    if ((grants.length > 0 && !ctx.capabilities.includes('access.role.capability.grant')) || (revokes.length > 0 && !ctx.capabilities.includes('access.role.capability.revoke'))) {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    try { await value.changeRoleCapabilities(req.params.id, grants, revokes, ctx.activeCompanyId, ctx.user.id); res.status(204).end(); }
    catch (error) { if (!handleKnownError(error, res)) throw error; }
  }),
);
