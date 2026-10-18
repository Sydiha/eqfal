import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { LedgerSourceAuthorityError, LedgerSourceAuthorityNotFoundError, LedgerSourceAuthorityService } from '../accounting/ledger-source-authority';
import { CutoverActivationService, CutoverValidationError, parseCutoverInput } from '../accounting/cutover-activation';
import { CutoverJournalBlockedError, JournalPostingConflictError, JournalPostingValidationError } from '../accounting/journal-posting';
import { AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { FiscalYearClosedError } from '../accounting/fiscal-year-posting.guard';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';

// C1B-2: read plus DRAFT create/void. C1B-3b: cut-over preview and ACTIVATION, the only way a range becomes active. Activation posts the
// approved trial balance as one `cutover_balance` journal and flips the range in a single transaction; it needs the independent critical
// capability `source_authority.activate` (granted to no default role). There is deliberately no route that voids an active range.
export const ledgerSourceAuthorityRouter = Router();
const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next: NextFunction) => {
  void handler(req, res).catch((error: unknown) => {
    if (error instanceof LedgerSourceAuthorityNotFoundError) { res.status(404).json({ error: 'Not found' }); return; }
    if (error instanceof CutoverValidationError) {
      const input = ['CUTOVER_INPUT_INVALID', 'CUTOVER_LINES_INVALID', 'CUTOVER_PREPARER_REQUIRED', 'CUTOVER_TB_REFERENCE_REQUIRED', 'CUTOVER_ACK_REQUIRED'].includes(error.code);
      res.status(input ? 400 : 409).json({ error: error.message, code: error.code, ...(error.findings.length ? { blockers: error.findings } : {}) });
      return;
    }
    if (error instanceof CutoverJournalBlockedError) { res.status(409).json({ error: error.message, code: error.code }); return; }
    if (error instanceof AccountingPeriodClosedError) { res.status(409).json({ error: error.message, code: 'ACCOUNTING_PERIOD_CLOSED' }); return; }
    if (error instanceof FiscalYearClosedError) { res.status(409).json({ error: error.message, code: 'FISCAL_YEAR_CLOSED' }); return; }
    if (error instanceof JournalPostingValidationError) { res.status(400).json({ error: error.message, code: 'CUTOVER_JOURNAL_INVALID' }); return; }
    if (error instanceof JournalPostingConflictError) { res.status(409).json({ error: error.message, code: 'CUTOVER_JOURNAL_CONFLICT' }); return; }
    if (error instanceof LedgerSourceAuthorityError) {
      res.status(error.code === 'AUTHORITY_RANGE_INVALID' ? 400 : 409).json({ error: error.message, code: error.code });
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
const idOf = (req: Request): string | null => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params['id'] ?? '') ? req.params['id']! : null);

// Read-only: runs every activation check and returns the figures the accountant must confirm. Posts nothing, takes no accounting lock.
ledgerSourceAuthorityRouter.post('/ledger-source-authority/:id/cutover-preview', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(ACTIVATE), route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const id = idOf(req);
  if (!id) { res.status(404).json({ error: 'Not found' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  res.json({ preview: await new CutoverActivationService(pool).preview(ctx.activeCompanyId!, id, parseCutoverInput(req.body, 'preview')) });
}));

ledgerSourceAuthorityRouter.post('/ledger-source-authority/:id/activate', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(ACTIVATE), route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const id = idOf(req);
  if (!id) { res.status(404).json({ error: 'Not found' }); return; }
  if (typeof req.body !== 'object' || req.body === null || req.body['confirm'] !== true) { res.status(400).json({ error: 'Explicit confirmation is required', code: 'CONFIRMATION_REQUIRED' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  res.status(201).json({ activation: await new CutoverActivationService(pool).activate(ctx.activeCompanyId!, ctx.user.id, id, parseCutoverInput(req.body, 'activate')) });
}));
