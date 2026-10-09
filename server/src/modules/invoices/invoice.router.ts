import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { InvoiceDraftService, InvoiceError, parseDraft, parseListQuery } from './invoice.service';

/**
 * Invoice draft API (PR-2B). invoice.view / invoice.create / invoice.edit are explicit-grant-only
 * (migration 063): Full Access does not hold them unless a role_capabilities row grants them.
 */
export const invoiceRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
const read = [requireAuth, requireActiveCompany];
const write = [requireSameOrigin, requireAuth, requireActiveCompany];

function companyAndActor(req: Request) {
  const ctx = getAuthenticatedContext(req)!;
  return { companyId: ctx.activeCompanyId!, actorUserId: ctx.user.id };
}

function service(res: Response): InvoiceDraftService | null {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return null; }
  return new InvoiceDraftService(pool);
}

/** Known errors get a stable { error, code } body; anything else goes to the central error boundary. */
async function handle(res: Response, work: (svc: InvoiceDraftService) => Promise<void>) {
  const svc = service(res);
  if (!svc) return;
  try {
    await work(svc);
  } catch (error) {
    if (error instanceof InvoiceError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    throw error;
  }
}

const invalidId = (res: Response) => res.status(404).json({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });

invoiceRouter.get('/invoices', ...read, requireCapability('invoice.view'), route((req, res) => handle(res, async (svc) => {
  const filters = parseListQuery(req.query as Record<string, unknown>);
  res.json(await svc.list(companyAndActor(req).companyId, filters));
})));

invoiceRouter.get('/invoices/:id', ...read, requireCapability('invoice.view'), route((req, res) => handle(res, async (svc) => {
  if (!UUID.test(req.params.id!)) { invalidId(res); return; }
  res.json({ invoice: await svc.get(companyAndActor(req).companyId, req.params.id!) });
})));

invoiceRouter.post('/invoices', ...write, requireCapability('invoice.create'), route((req, res) => handle(res, async (svc) => {
  const body = req.body as Record<string, unknown>;
  const direction = body && typeof body === 'object' ? body.direction : undefined;
  if (direction !== 'sales' && direction !== 'purchase') throw new InvoiceError(400, 'INVOICE_VALIDATION', 'direction must be sales or purchase');
  const input = parseDraft(body, ['direction']);
  const { companyId, actorUserId } = companyAndActor(req);
  res.status(201).json({ invoice: await svc.create(companyId, actorUserId, direction, input) });
})));

invoiceRouter.put('/invoices/:id', ...write, requireCapability('invoice.edit'), route((req, res) => handle(res, async (svc) => {
  if (!UUID.test(req.params.id!)) { invalidId(res); return; }
  const body = req.body as Record<string, unknown>;
  const version = body && typeof body === 'object' ? body.version : undefined;
  if (!Number.isInteger(version) || (version as number) < 1) throw new InvoiceError(400, 'INVOICE_VALIDATION', 'version must be a positive integer');
  const input = parseDraft(body, ['version']);
  const { companyId, actorUserId } = companyAndActor(req);
  res.json({ invoice: await svc.update(companyId, actorUserId, req.params.id!, version as number, input) });
})));

function parseVersion(req: Request): number {
  const body = req.body as Record<string, unknown>;
  const version = body && typeof body === 'object' ? body.version : undefined;
  if (!Number.isInteger(version) || (version as number) < 1) throw new InvoiceError(400, 'INVOICE_VALIDATION', 'version must be a positive integer');
  return version as number;
}

// PR-3A: submit / return. invoice.submit is explicit-grant-only (migration 064). Final approval is NOT exposed.
invoiceRouter.post('/invoices/:id/submit', ...write, requireCapability('invoice.submit'), route((req, res) => handle(res, async (svc) => {
  if (!UUID.test(req.params.id!)) { invalidId(res); return; }
  const version = parseVersion(req);
  const { companyId, actorUserId } = companyAndActor(req);
  res.json({ invoice: await svc.submit(companyId, actorUserId, req.params.id!, version) });
})));

invoiceRouter.post('/invoices/:id/return', ...write, requireCapability('invoice.submit'), route((req, res) => handle(res, async (svc) => {
  if (!UUID.test(req.params.id!)) { invalidId(res); return; }
  const version = parseVersion(req);
  const { companyId, actorUserId } = companyAndActor(req);
  res.json({ invoice: await svc.returnToDraft(companyId, actorUserId, req.params.id!, version) });
})));
