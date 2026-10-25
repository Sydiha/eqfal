import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { InvoiceError } from './invoice.service';
import { parseTemplate, RecurringInvoiceService } from './recurring-invoice.service';

/**
 * Recurring invoice template API. Reading needs invoice.view. Every change (create, edit, pause, resume, end, manual run) needs invoice.recurring,
 * which is explicit-grant-only (migration 073); no role holds it by default. Generated invoices are drafts and enter the normal invoice workflow.
 */
export const recurringInvoiceRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
const read = [requireAuth, requireActiveCompany];
const write = [requireSameOrigin, requireAuth, requireActiveCompany];

async function handle(res: Response, work: (svc: RecurringInvoiceService) => Promise<void>) {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  try {
    await work(new RecurringInvoiceService(pool));
  } catch (error) {
    if (error instanceof InvoiceError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    throw error;
  }
}
const who = (req: Request) => { const ctx = getAuthenticatedContext(req)!; return { companyId: ctx.activeCompanyId!, actorUserId: ctx.user.id, capabilities: ctx.capabilities }; };
const notFound = (res: Response) => res.status(404).json({ error: 'Recurring template not found', code: 'RECURRING_NOT_FOUND' });
function version(req: Request): number {
  const v = (req.body as Record<string, unknown> | undefined)?.version;
  if (!Number.isInteger(v) || (v as number) < 1) throw new InvoiceError(400, 'INVOICE_VALIDATION', 'version must be a positive integer');
  return v as number;
}

recurringInvoiceRouter.get('/recurring-invoices', ...read, requireCapability('invoice.view'), route((req, res) => handle(res, async (svc) => {
  const { direction, status, ...rest } = req.query as Record<string, unknown>;
  if (Object.keys(rest).length) throw new InvoiceError(400, 'INVOICE_VALIDATION', 'Unknown query parameters');
  if (direction != null && direction !== 'sales' && direction !== 'purchase') throw new InvoiceError(400, 'INVOICE_VALIDATION', 'direction must be sales or purchase');
  if (status != null && !['active', 'paused', 'ended'].includes(status as string)) throw new InvoiceError(400, 'INVOICE_VALIDATION', 'status is not valid');
  res.json(await svc.list(who(req).companyId, { direction: (direction as 'sales' | 'purchase') ?? null, status: (status as string) ?? null }));
})));

recurringInvoiceRouter.get('/recurring-invoices/:id', ...read, requireCapability('invoice.view'), route((req, res) => handle(res, async (svc) => {
  if (!UUID.test(req.params.id!)) { notFound(res); return; }
  res.json({ template: await svc.get(who(req).companyId, req.params.id!) });
})));

recurringInvoiceRouter.post('/recurring-invoices', ...write, requireCapability('invoice.recurring'), route((req, res) => handle(res, async (svc) => {
  const body = req.body as Record<string, unknown>;
  const direction = body && typeof body === 'object' ? body.direction : undefined;
  if (direction !== 'sales' && direction !== 'purchase') throw new InvoiceError(400, 'INVOICE_VALIDATION', 'direction must be sales or purchase');
  const input = parseTemplate(body, ['direction']);
  const { companyId, actorUserId } = who(req);
  res.status(201).json({ template: await svc.create(companyId, actorUserId, direction, input) });
})));

recurringInvoiceRouter.put('/recurring-invoices/:id', ...write, requireCapability('invoice.recurring'), route((req, res) => handle(res, async (svc) => {
  if (!UUID.test(req.params.id!)) { notFound(res); return; }
  const v = version(req);
  const input = parseTemplate(req.body, ['version']);
  const { companyId, actorUserId } = who(req);
  res.json({ template: await svc.update(companyId, actorUserId, req.params.id!, v, input) });
})));

for (const action of ['pause', 'resume', 'end'] as const) {
  recurringInvoiceRouter.post(`/recurring-invoices/:id/${action}`, ...write, requireCapability('invoice.recurring'), route((req, res) => handle(res, async (svc) => {
    if (!UUID.test(req.params.id!)) { notFound(res); return; }
    const v = version(req);
    const { companyId, actorUserId } = who(req);
    res.json({ template: await svc[action](companyId, actorUserId, req.params.id!, v) });
  })));
}

// Manual "generate due drafts now" for the active company. Needs invoice.create as well, because it creates draft invoices. Only occurrences already due are generated.
recurringInvoiceRouter.post('/recurring-invoices/run-due', ...write, requireCapability('invoice.recurring'), route((req, res) => handle(res, async (svc) => {
  const { companyId, capabilities } = who(req);
  if (!capabilities.includes('invoice.create')) { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); return; }
  res.json({ results: await svc.runDueForCompany(companyId) });
})));
