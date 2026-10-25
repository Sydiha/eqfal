import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { InvoiceError } from './invoice.service';
import { InvoiceAccountMappingService } from './invoice-account-mapping.service';

/**
 * Invoice account mapping management. Viewing (invoice.mapping.view) never implies changing (invoice.mapping.manage). Every call is scoped to the
 * active company; the service validates company ownership, active status and account type. Mapping changes never touch invoices or journals.
 */
export const invoiceAccountMappingRouter = Router();

const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
const read = [requireAuth, requireActiveCompany];
const write = [requireSameOrigin, requireAuth, requireActiveCompany];

async function work(res: Response, run: () => Promise<void>) {
  try { await run(); } catch (error) {
    if (error instanceof InvoiceError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    throw error;
  }
}

invoiceAccountMappingRouter.get('/invoice-account-mappings', ...read, requireCapability('invoice.mapping.view'), route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  res.json({ mappings: await new InvoiceAccountMappingService(pool).overview(getAuthenticatedContext(req)!.activeCompanyId!) });
}));

invoiceAccountMappingRouter.put('/invoice-account-mappings/:key', ...write, requireCapability('invoice.mapping.view'), requireCapability('invoice.mapping.manage'), route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  await work(res, async () => {
    const svc = new InvoiceAccountMappingService(pool!);
    await svc.set(ctx.activeCompanyId!, ctx.user.id, req.params.key, (req.body as { account_id?: unknown } | undefined)?.account_id);
    res.json({ mappings: await svc.overview(ctx.activeCompanyId!) });
  });
}));

invoiceAccountMappingRouter.delete('/invoice-account-mappings/:key', ...write, requireCapability('invoice.mapping.view'), requireCapability('invoice.mapping.manage'), route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  await work(res, async () => {
    const svc = new InvoiceAccountMappingService(pool!);
    await svc.clear(ctx.activeCompanyId!, ctx.user.id, req.params.key);
    res.json({ mappings: await svc.overview(ctx.activeCompanyId!) });
  });
}));
