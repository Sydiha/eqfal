import { NextFunction, Request, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { AnnualClosingNotFoundError, AnnualClosingService } from './annual-closing.service';

export const annualClosingRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

annualClosingRouter.get('/annual-closing/:fiscalYearId', requireAuth, requireActiveCompany, requireCapability('annual_close.view'), (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    if (!UUID.test(req.params.fiscalYearId)) { res.status(400).json({ error: 'Invalid fiscal year' }); return; }
    if (!pool) { res.status(503).json({ error: 'Database unavailable' }); return; }
    const context = getAuthenticatedContext(req)! as ReturnType<typeof getAuthenticatedContext> & { activeCompanyId: string };
    try { res.json(await new AnnualClosingService(pool).readiness(context.activeCompanyId, req.params.fiscalYearId)); }
    catch (error) { if (error instanceof AnnualClosingNotFoundError) res.status(404).json({ error: 'Not found' }); else next(error); }
  })().catch(next);
});
