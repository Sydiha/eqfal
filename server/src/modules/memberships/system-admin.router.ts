import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireAuth } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { CompanyAccessError, CompanyManagementService } from '../companies/company.service';
import { handleKnownError } from './access-administration.router';
import { sensitivityMap } from './capability-sensitivity';
import { MembershipService } from './membership.service';
import { SystemAdminService } from './system-admin.service';

/**
 * Global administration (/api/admin/*) for an active System Admin only. These routes do NOT need an active company or
 * a membership in the target company: the target company is taken from the path or from the DB row being changed and
 * verified server-side. Company-scoped rules (ceilings, Full Access authority, last Full Access, audit_log) are the
 * same MembershipService / CompanyManagementService code paths used by company managers; global account changes are
 * audited in system_audit_log. Financial data is NOT served here; a System Admin reaches it through the normal
 * company-scoped routes after selecting the company.
 */
export const systemAdminRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BAD = { error: 'Invalid administration request' };
const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);

/** Re-reads System Admin status from the database on every request (the session flag is only a UI hint). */
const requireSystemAdmin: RequestHandler = (req, res, next) => {
  const ctx = getAuthenticatedContext(req);
  if (!ctx) { res.status(401).json({ error: 'Unauthenticated' }); return; }
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  SystemAdminService.isActiveSystemAdmin(pool, ctx.user.id)
    .then((ok) => { if (ok) next(); else res.status(403).json({ error: 'Forbidden', code: 'ACCESS_SYSTEM_ADMIN_REQUIRED' }); })
    .catch(next);
};
const read = [requireAuth, requireSystemAdmin];
const write = [requireSameOrigin, requireAuth, requireSystemAdmin];

const actor = (req: Request) => getAuthenticatedContext(req)!.user.id;
function exactObject(body: unknown, keys: string[]): body is Record<string, unknown> {
  return !!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));
}
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}
function fail(error: unknown, res: Response): void {
  if (error instanceof CompanyAccessError) {
    if (error.kind === 'not_found') res.status(404).json({ error: 'Not found' });
    else if (error.kind === 'forbidden') res.status(403).json({ error: 'Forbidden' });
    else res.status(409).json({ error: 'Conflict', ...(error.code ? { code: error.code } : {}) });
    return;
  }
  if (!handleKnownError(error, res)) throw error;
}
const db = () => pool!;

// ── Catalog ───────────────────────────────────────────────────────────────
systemAdminRouter.get('/admin/capabilities', ...read, asyncRoute(async (_req, res) => {
  const capabilities = await new MembershipService(db()).listCapabilities();
  res.json({ capabilities, sensitivity: sensitivityMap(capabilities) });
}));

// ── Companies ─────────────────────────────────────────────────────────────
systemAdminRouter.get('/admin/companies', ...read, asyncRoute(async (req, res) => {
  res.json({ companies: await new CompanyManagementService(db()).listForUser(actor(req)) });
}));

systemAdminRouter.post('/admin/companies', ...write, asyncRoute(async (req, res) => {
  const body = req.body as unknown;
  const ok = exactObject(body, ['slug', 'name', 'name_ar']);
  const slug = ok ? text(body.slug, 64) : null;
  const name = ok ? text(body.name, 200) : null;
  const rawAr = ok ? body.name_ar : undefined;
  const nameAr = rawAr === undefined || rawAr === null || rawAr === '' ? null : text(rawAr, 200);
  if (!slug || !SLUG.test(slug) || !name || (rawAr !== undefined && rawAr !== null && rawAr !== '' && nameAr === null)) { res.status(400).json(BAD); return; }
  try { res.status(201).json(await new CompanyManagementService(db()).create({ slug, name, name_ar: nameAr }, actor(req))); }
  catch (error) {
    if ((error as { code?: string }).code === '23505') { res.status(409).json({ error: 'Conflict', code: 'COMPANY_SLUG_CONFLICT' }); return; }
    fail(error, res);
  }
}));

systemAdminRouter.patch('/admin/companies/:id/active', ...write, asyncRoute(async (req, res) => {
  if (!UUID.test(req.params.id!) || !exactObject(req.body, ['is_active']) || typeof req.body.is_active !== 'boolean') { res.status(400).json(BAD); return; }
  try { res.json(await new CompanyManagementService(db()).setActive(req.params.id!, req.body.is_active, actor(req))); }
  catch (error) { fail(error, res); }
}));

systemAdminRouter.get('/admin/companies/:id/roles', ...read, asyncRoute(async (req, res) => {
  if (!UUID.test(req.params.id!)) { res.status(400).json(BAD); return; }
  res.json({ roles: await new MembershipService(db()).listRoles(req.params.id!) });
}));

// ── Users ─────────────────────────────────────────────────────────────────
systemAdminRouter.get('/admin/users', ...read, asyncRoute(async (req, res) => {
  const raw = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  if (raw.length > 254) { res.status(400).json(BAD); return; }
  res.json({ users: await new SystemAdminService(db()).listUsers(raw || null) });
}));

const MIN_PASSWORD = 8;
systemAdminRouter.post('/admin/users', ...write, asyncRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const email = exactObject(body, ['email', 'password']) && typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || email.length > 254 || !EMAIL.test(email) || password.length < MIN_PASSWORD || password.length > 256) { res.status(400).json(BAD); return; }
  try { res.status(201).json(await new SystemAdminService(db()).createUser(email, password, actor(req))); }
  catch (error) { fail(error, res); }
}));

systemAdminRouter.patch('/admin/users/:id/active', ...write, asyncRoute(async (req, res) => {
  if (!UUID.test(req.params.id!) || !exactObject(req.body, ['is_active']) || typeof req.body.is_active !== 'boolean') { res.status(400).json(BAD); return; }
  try { res.json(await new SystemAdminService(db()).setUserActive(req.params.id!, req.body.is_active, actor(req))); }
  catch (error) { fail(error, res); }
}));

systemAdminRouter.put('/admin/users/:id/system-admin', ...write, asyncRoute(async (req, res) => {
  if (!UUID.test(req.params.id!) || !exactObject(req.body, ['is_system_admin']) || typeof req.body.is_system_admin !== 'boolean') { res.status(400).json(BAD); return; }
  try { res.json(await new SystemAdminService(db()).setSystemAdmin(req.params.id!, req.body.is_system_admin, actor(req))); }
  catch (error) { fail(error, res); }
}));

systemAdminRouter.get('/admin/users/:id/memberships', ...read, asyncRoute(async (req, res) => {
  if (!UUID.test(req.params.id!)) { res.status(400).json(BAD); return; }
  const memberships = await new SystemAdminService(db()).listUserMemberships(req.params.id!);
  if (!memberships) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ memberships });
}));

// ── Memberships (any company; same rules as company administration) ───────
systemAdminRouter.post('/admin/memberships', ...write, asyncRoute(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const ok = exactObject(body, ['user_id', 'company_id', 'role_id'])
    && typeof body.user_id === 'string' && UUID.test(body.user_id)
    && typeof body.company_id === 'string' && UUID.test(body.company_id)
    && (body.role_id === undefined || body.role_id === null || (typeof body.role_id === 'string' && UUID.test(body.role_id)));
  if (!ok) { res.status(400).json(BAD); return; }
  try { res.status(201).json(await new MembershipService(db()).addUserToCompany(body.user_id as string, body.company_id as string, (body.role_id as string | null | undefined) ?? null, actor(req))); }
  catch (error) { fail(error, res); }
}));

async function withMembershipCompany(req: Request, res: Response, work: (svc: MembershipService, companyId: string) => Promise<unknown>): Promise<void> {
  const svc = new MembershipService(db());
  const companyId = await svc.membershipCompanyId(req.params.id!);
  if (!companyId) { res.status(404).json({ error: 'Not found' }); return; }
  try { res.json(await work(svc, companyId)); }
  catch (error) { fail(error, res); }
}

systemAdminRouter.patch('/admin/memberships/:id/active', ...write, asyncRoute(async (req, res) => {
  if (!UUID.test(req.params.id!) || !exactObject(req.body, ['is_active']) || typeof req.body.is_active !== 'boolean') { res.status(400).json(BAD); return; }
  await withMembershipCompany(req, res, (svc, companyId) => svc.setMembershipActive(req.params.id!, companyId, req.body.is_active as boolean, actor(req)));
}));

systemAdminRouter.put('/admin/memberships/:id/role', ...write, asyncRoute(async (req, res) => {
  if (!UUID.test(req.params.id!) || !exactObject(req.body, ['role_id']) || typeof req.body.role_id !== 'string' || !UUID.test(req.body.role_id)) { res.status(400).json(BAD); return; }
  await withMembershipCompany(req, res, (svc, companyId) => svc.assignRoleForCompany(req.params.id!, req.body.role_id as string, companyId, actor(req)));
}));
