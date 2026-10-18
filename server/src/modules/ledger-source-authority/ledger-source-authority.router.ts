import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { LedgerCutoverService, parseCutoverInput } from '../accounting/ledger-cutover';
import { LedgerSourceAuthorityError, LedgerSourceAuthorityNotFoundError, LedgerSourceAuthorityService } from '../accounting/ledger-source-authority';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';

// C1B-2: read plus DRAFT create/void. A draft has no accounting effect.
// C1B-3b: preview and activate (the ONLY path to an active range): the cut-over trial balance becomes one posted `cutover_balance` journal and
// the range turns active in the same transaction. Requires the independent critical capability source_authority.activate (no role holds it by default).
export const ledgerSourceAuthorityRouter = Router();
const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next: NextFunction) => {
  void handler(req, res).catch((error) => {
    if (error instanceof LedgerSourceAuthorityNotFoundError) { res.status(404).json({ error: 'Not found' }); return; }
    if (error instanceof LedgerSourceAuthorityError) {
      res.status(error.code === 'AUTHORITY_RANGE_INVALID' || error.code === 'CUTOVER_LINES_INVALID' ? 400 : 409).json({ error: error.message, code: error.code });
      return;
    }
    next(error);
  });
};
const onlyKeys = (body: unknown, keys: string[]): body is Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body) && Object.keys(body).every((key) => keys.includes(key));
const MANAGE = ['source_authority.manage'] as const;

ledgerSourceAuthorityRouter.get('/ledger-source-authority', requireAuth, requireActiveCompany, requireCapability('source_authority.view'), route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const companyId = getAuthenticatedContext(req)!.activeCompanyId!;
  res.json({ ranges: await new LedgerSourceAuthorityService(pool).list(companyId) });
}));

ledgerSourceAuthorityRouter.post('/ledger-source-authority/drafts', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(MANAGE[0]), route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  if (!onlyKeys(req.body, ['from_date', 'to_date', 'reason', 'confirm'])) { res.status(400).json({ error: 'Invalid request', code: 'AUTHORITY_RANGE_INVALID' }); return; }
  if (req.body['confirm'] !== true) { res.status(400).json({ error: 'Explicit confirmation is required', code: 'CONFIRMATION_REQUIRED' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  const range = await new LedgerSourceAuthorityService(pool).createDraft(ctx.activeCompanyId!, ctx.user.id, { fromDate: req.body['from_date'], toDate: req.body['to_date'], reason: req.body['reason'] });
  res.status(201).json({ range });
}));

ledgerSourceAuthorityRouter.post('/ledger-source-authority/:id/void-draft', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(MANAGE[0]), route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  if (!onlyKeys(req.body, ['reason', 'confirm'])) { res.status(400).json({ error: 'Invalid request', code: 'AUTHORITY_RANGE_INVALID' }); return; }
  if (req.body['confirm'] !== true) { res.status(400).json({ error: 'Explicit confirmation is required', code: 'CONFIRMATION_REQUIRED' }); return; }
  const id = req.params['id'] ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { res.status(404).json({ error: 'Not found' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  res.json({ range: await new LedgerSourceAuthorityService(pool).voidDraft(ctx.activeCompanyId!, ctx.user.id, id, req.body['reason']) });
}));

const ACTIVATE = 'source_authority.activate';
const uuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

ledgerSourceAuthorityRouter.post('/ledger-source-authority/:id/cutover/preview', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(ACTIVATE), route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const id = req.params['id'] ?? '';
  if (!uuid(id)) { res.status(404).json({ error: 'Not found' }); return; }
  const input = parseCutoverInput(req.body, false);
  if (!input) { res.status(400).json({ error: 'Invalid request', code: 'CUTOVER_LINES_INVALID' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  res.json(await new LedgerCutoverService(pool).preview(ctx.activeCompanyId!, ctx.user.id, id, input));
}));

ledgerSourceAuthorityRouter.post('/ledger-source-authority/:id/activate', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(ACTIVATE), route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const id = req.params['id'] ?? '';
  if (!uuid(id)) { res.status(404).json({ error: 'Not found' }); return; }
  if (typeof req.body !== 'object' || req.body === null || req.body['confirm'] !== true) { res.status(400).json({ error: 'Explicit confirmation is required', code: 'CONFIRMATION_REQUIRED' }); return; }
  const input = parseCutoverInput(req.body, true);
  if (!input) { res.status(400).json({ error: 'Invalid request', code: 'CUTOVER_LINES_INVALID' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  const result = await new LedgerCutoverService(pool).activate(ctx.activeCompanyId!, ctx.user.id, id, input);
  res.status(result.replayed ? 200 : 201).json(result);
}));
