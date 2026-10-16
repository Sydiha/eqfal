import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { LedgerSourceAuthorityService } from '../accounting/ledger-source-authority';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';

// C1B-1: read-only. Authority ranges are created and voided only by the approved cut-over workflow (C1B-2); no write route exists.
export const ledgerSourceAuthorityRouter = Router();
const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next: NextFunction) => void handler(req, res).catch(next);

ledgerSourceAuthorityRouter.get('/ledger-source-authority', requireAuth, requireActiveCompany, requireCapability('source_authority.view'), route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const companyId = getAuthenticatedContext(req)!.activeCompanyId!;
  res.json({ ranges: await new LedgerSourceAuthorityService(pool).list(companyId) });
}));
