import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { HistoricalActor, HistoricalError, HistoricalRecordsService } from './historical-records.service';

// C5-P3: historical records API. The company is always the session's active company. Reads need historical.view; drafts, lines, sealing, voiding,
// corrections and period status need historical.manage; internal review/approval and reopening a completed reconstruction need historical.approve.
// The service re-checks the capability. Internal approval never implies acceptance by any authority.
export const historicalRecordsRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIEW = [requireAuth, requireActiveCompany, requireCapability('historical.view')];
const WRITE = [requireSameOrigin, requireAuth, requireActiveCompany, requireCapability('historical.manage')];
const APPROVE = [requireSameOrigin, requireAuth, requireActiveCompany, requireCapability('historical.approve')];

type Handler = (req: Request, res: Response, ctx: { actor: HistoricalActor; service: HistoricalRecordsService; ids: string[] }) => Promise<void>;

const route = (idParams: string[], handler: Handler): RequestHandler => (req, res, next: NextFunction) => {
  void (async () => {
    if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
    const ids = idParams.map((p) => req.params[p] ?? '');
    if (ids.some((id) => !UUID.test(id))) { res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }); return; }
    const ctx = getAuthenticatedContext(req)!;
    const actor: HistoricalActor = { userId: ctx.user.id, companyId: ctx.activeCompanyId!, capabilities: ctx.capabilities };
    await handler(req, res, { actor, service: new HistoricalRecordsService(pool), ids });
  })().catch((error) => {
    if (error instanceof HistoricalError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    next(error);
  });
};
const confirmed = (req: Request): void => {
  if (req.body?.['confirm'] !== true) throw new HistoricalError('CONFIRMATION_REQUIRED', 'Explicit confirmation is required', 400);
};

historicalRecordsRouter.get('/historical/periods', ...VIEW, route([], async (_req, res, { actor, service }) => {
  res.json({ periods: await service.listPeriods(actor) });
}));
historicalRecordsRouter.post('/historical/periods', ...WRITE, route([], async (req, res, { actor, service }) => {
  res.status(201).json({ period: await service.createPeriod(actor, req.body) });
}));
historicalRecordsRouter.get('/historical/periods/:id', ...VIEW, route(['id'], async (_req, res, { actor, service, ids }) => {
  res.json(await service.getPeriod(actor, ids[0]!));
}));
historicalRecordsRouter.patch('/historical/periods/:id/status', ...WRITE, route(['id'], async (req, res, { actor, service, ids }) => {
  res.json({ period: await service.updatePeriodStatus(actor, ids[0]!, req.body) });
}));
historicalRecordsRouter.post('/historical/periods/:id/reopen-reconstruction', ...APPROVE, route(['id'], async (req, res, { actor, service, ids }) => {
  confirmed(req);
  res.json({ period: await service.reopenReconstruction(actor, ids[0]!, req.body) });
}));

historicalRecordsRouter.get('/historical/periods/:id/versions', ...VIEW, route(['id'], async (req, res, { actor, service, ids }) => {
  const st = req.query['statement_type'];
  res.json({ versions: await service.listVersions(actor, ids[0]!, typeof st === 'string' ? st : undefined) });
}));
historicalRecordsRouter.post('/historical/periods/:id/versions', ...WRITE, route(['id'], async (req, res, { actor, service, ids }) => {
  res.status(201).json({ version: await service.createVersion(actor, ids[0]!, req.body) });
}));
historicalRecordsRouter.get('/historical/versions/:id', ...VIEW, route(['id'], async (_req, res, { actor, service, ids }) => {
  res.json(await service.getVersion(actor, ids[0]!));
}));
historicalRecordsRouter.get('/historical/versions/:id/history', ...VIEW, route(['id'], async (_req, res, { actor, service, ids }) => {
  res.json(await service.history(actor, ids[0]!));
}));
historicalRecordsRouter.get('/historical/versions/:id/comparison', ...VIEW, route(['id'], async (req, res, { actor, service, ids }) => {
  const against = req.query['against'];
  res.json(await service.compare(actor, ids[0]!, typeof against === 'string' ? against : undefined));
}));
historicalRecordsRouter.patch('/historical/versions/:id', ...WRITE, route(['id'], async (req, res, { actor, service, ids }) => {
  res.json({ version: await service.updateDraft(actor, ids[0]!, req.body) });
}));
historicalRecordsRouter.post('/historical/versions/:id/lines', ...WRITE, route(['id'], async (req, res, { actor, service, ids }) => {
  res.status(201).json({ line: await service.addLine(actor, ids[0]!, req.body) });
}));
historicalRecordsRouter.patch('/historical/versions/:id/lines/:lineId', ...WRITE, route(['id', 'lineId'], async (req, res, { actor, service, ids }) => {
  res.json({ line: await service.updateLine(actor, ids[0]!, ids[1]!, req.body) });
}));
historicalRecordsRouter.delete('/historical/versions/:id/lines/:lineId', ...WRITE, route(['id', 'lineId'], async (_req, res, { actor, service, ids }) => {
  res.json(await service.removeLine(actor, ids[0]!, ids[1]!));
}));
historicalRecordsRouter.post('/historical/versions/:id/seal', ...WRITE, route(['id'], async (req, res, { actor, service, ids }) => {
  confirmed(req);
  res.json({ version: await service.seal(actor, ids[0]!) });
}));
historicalRecordsRouter.post('/historical/versions/:id/void', ...WRITE, route(['id'], async (req, res, { actor, service, ids }) => {
  confirmed(req);
  res.json({ version: await service.voidDraft(actor, ids[0]!, req.body) });
}));
historicalRecordsRouter.post('/historical/versions/:id/corrections', ...WRITE, route(['id'], async (req, res, { actor, service, ids }) => {
  confirmed(req);
  res.status(201).json({ version: await service.createCorrection(actor, ids[0]!, req.body) });
}));
historicalRecordsRouter.post('/historical/versions/:id/review', ...APPROVE, route(['id'], async (req, res, { actor, service, ids }) => {
  confirmed(req);
  res.json({ version: await service.review(actor, ids[0]!, req.body) });
}));
