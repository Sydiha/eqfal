import express, { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { MAX_LOGO_BYTES, inspectLogo } from './logo-image';
import { CompanyAccessError, CompanyManagementService } from './company.service';

export const companyRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);

const base = [requireAuth, requireActiveCompany];
const writeGuards = (capability: string): RequestHandler[] => [requireSameOrigin, ...base, requireCapability(capability)];
const BAD = { error: 'Invalid company request' };

function exactObject(body: unknown, keys: string[]): body is Record<string, unknown> {
  return !!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));
}
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}
function service(res: Response): CompanyManagementService | null {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return null; }
  return new CompanyManagementService(pool);
}
function actor(req: Request): string { return getAuthenticatedContext(req)!.user.id; }

function handleKnownError(error: unknown, res: Response): boolean {
  if (error instanceof CompanyAccessError) {
    if (error.kind === 'not_found') res.status(404).json({ error: 'Not found' });
    else if (error.kind === 'forbidden') res.status(403).json({ error: 'Forbidden' });
    else res.status(409).json({ error: 'Conflict', ...(error.code ? { code: error.code } : {}) });
    return true;
  }
  // companies has a single unique index (slug), so 23505 is a slug conflict.
  if ((error as { code?: string }).code === '23505') { res.status(409).json({ error: 'Conflict', code: 'COMPANY_SLUG_CONFLICT' }); return true; }
  return false;
}

companyRouter.get('/companies', ...base, requireCapability('company.view'), asyncRoute(async (req, res) => {
  const value = service(res);
  if (value) res.json({ companies: await value.listForUser(actor(req)) });
}));

companyRouter.post('/companies', ...writeGuards('company.create'), asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  const body = req.body as unknown;
  const slug = exactObject(body, ['slug', 'name', 'name_ar']) ? text(body.slug, 64) : null;
  const name = exactObject(body, ['slug', 'name', 'name_ar']) ? text(body.name, 200) : null;
  const rawAr = exactObject(body, ['slug', 'name', 'name_ar']) ? body.name_ar : undefined;
  const nameAr = rawAr === undefined || rawAr === null || rawAr === '' ? null : text(rawAr, 200);
  if (!slug || !SLUG.test(slug) || !name || (rawAr !== undefined && rawAr !== null && rawAr !== '' && nameAr === null)) {
    res.status(400).json(BAD); return;
  }
  try { res.status(201).json(await value.create({ slug, name, name_ar: nameAr }, actor(req))); }
  catch (error) { if (!handleKnownError(error, res)) throw error; }
}));

companyRouter.patch('/companies/:id', requireSameOrigin, ...base, asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  const body = req.body as unknown;
  if (!UUID.test(req.params.id) || !exactObject(body, ['name', 'name_ar']) || Object.keys(body).length === 0) { res.status(400).json(BAD); return; }
  const patch: { name?: string; name_ar?: string | null } = {};
  if ('name' in body) {
    const name = text(body.name, 200);
    if (!name) { res.status(400).json(BAD); return; }
    patch.name = name;
  }
  if ('name_ar' in body) {
    if (body.name_ar === null || body.name_ar === '') patch.name_ar = null;
    else {
      const nameAr = text(body.name_ar, 200);
      if (!nameAr) { res.status(400).json(BAD); return; }
      patch.name_ar = nameAr;
    }
  }
  try { res.json(await value.update(req.params.id, patch, actor(req))); }
  catch (error) { if (!handleKnownError(error, res)) throw error; }
}));

companyRouter.patch('/companies/:id/active', requireSameOrigin, ...base, asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  if (!UUID.test(req.params.id) || !exactObject(req.body, ['is_active']) || typeof req.body.is_active !== 'boolean') { res.status(400).json(BAD); return; }
  try { res.json(await value.setActive(req.params.id, req.body.is_active, actor(req))); }
  catch (error) { if (!handleKnownError(error, res)) throw error; }
}));

const logoParser = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: MAX_LOGO_BYTES });
const logoUpload: RequestHandler = (req, res, next) => logoParser(req, res, (error?: unknown) => {
  if ((error as { type?: string } | undefined)?.type === 'entity.too.large') { res.status(413).json({ error: 'Logo too large', code: 'LOGO_TOO_LARGE' }); return; }
  if (error) { next(error); return; }
  next();
});

// Logo: a member can read only the ACTIVE company's logo; any other id is reported as not found.
companyRouter.get('/companies/:id/logo', ...base, asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  const context = getAuthenticatedContext(req)!;
  if (!UUID.test(req.params.id) || req.params.id !== context.activeCompanyId) { res.status(404).json({ error: 'Not found' }); return; }
  try {
    const logo = await value.getLogo(req.params.id, actor(req));
    if (!logo) { res.status(404).json({ error: 'Not found' }); return; }
    const etag = `"${logo.sha256}"`;
    res.set({ 'Content-Type': logo.mime_type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-cache', ETag: etag, 'Content-Disposition': 'inline' });
    if (req.get('if-none-match') === etag) { res.status(304).end(); return; }
    res.status(200).send(logo.data);
  } catch (error) { if (!handleKnownError(error, res)) throw error; }
}));

companyRouter.put('/companies/:id/logo', requireSameOrigin, ...base, logoUpload, asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  const body = req.body as unknown;
  if (!UUID.test(req.params.id) || !Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_LOGO_BYTES) { res.status(400).json({ ...BAD, code: 'LOGO_INVALID' }); return; }
  const info = inspectLogo(body);
  // Declared content type must agree with the real bytes; SVG/other types never reach here (raw parser ignores them => empty body).
  if (!info || info.mime !== req.get('content-type')?.split(';')[0]?.trim().toLowerCase()) { res.status(400).json({ ...BAD, code: 'LOGO_INVALID' }); return; }
  try { res.json(await value.setLogo(req.params.id, info.mime, body, actor(req))); }
  catch (error) { if (!handleKnownError(error, res)) throw error; }
}));

companyRouter.delete('/companies/:id/logo', requireSameOrigin, ...base, asyncRoute(async (req, res) => {
  const value = service(res);
  if (!value) return;
  if (!UUID.test(req.params.id)) { res.status(400).json(BAD); return; }
  try { await value.removeLogo(req.params.id, actor(req)); res.status(204).end(); }
  catch (error) { if (!handleKnownError(error, res)) throw error; }
}));
