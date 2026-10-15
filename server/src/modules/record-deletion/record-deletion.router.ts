import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import config from '../../config';
import { getStorage } from '../../storage/storage.factory';
import { DeleteBlockedError, sendDeleteBlocked } from '../../shared/delete-guard';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { RecordDeletionService, RecordNotFoundError, RecordVersionConflictError } from './record-deletion.service';

/**
 * Delete & Void Phase 3 routes. Each deletion has its own capability (registered by migration 079, granted to no default role;
 * Full Access and System Admin hold it through the wildcard). Posted / confirmed / referenced records are refused (409 + reason).
 */
export const recordDeletionRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const write = [requireSameOrigin, requireAuth, requireActiveCompany];
const bankStorage = getStorage('bank-imports', config.bankStorageDir);

function parseVersion(req: Request): number {
  const raw = req.query.version;
  return typeof raw === 'string' && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : NaN;
}

function deletion(code: string, needsVersion: boolean, run: (svc: RecordDeletionService, companyId: string, actor: string, id: string, version: number) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const id = req.params.id!;
      if (!UUID.test(id)) { res.status(400).json({ error: 'Invalid id', code: 'INVALID_ID' }); return; }
      const version = parseVersion(req);
      if (needsVersion && !Number.isSafeInteger(version)) { res.status(400).json({ error: 'version must be a positive integer', code: 'VERSION_REQUIRED' }); return; }
      if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
      const ctx = getAuthenticatedContext(req)!;
      try {
        await run(new RecordDeletionService(pool, bankStorage), ctx.activeCompanyId!, ctx.user.id, id, version);
        res.json({ deleted: true, id });
      } catch (error) {
        if (error instanceof RecordNotFoundError) { res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }); return; }
        if (error instanceof RecordVersionConflictError) { res.status(409).json({ error: 'The record changed. Reload and try again.', code: 'VERSION_CONFLICT' }); return; }
        if (error instanceof DeleteBlockedError) { sendDeleteBlocked(res, code, error); return; }
        if (error instanceof AccountingPeriodClosedError) { res.status(409).json({ error: error.message, code: 'ACCOUNTING_PERIOD_CLOSED' }); return; }
        throw error;
      }
    })().catch(next);
  };
}

recordDeletionRouter.delete('/journals/:id', ...write, requireCapability('accounting.journal.delete'), deletion('JOURNAL_DELETE_BLOCKED', false, (s, c, a, id) => s.deleteJournal(c, a, id)));
recordDeletionRouter.delete('/periodic-adjustments/:id', ...write, requireCapability('periodic_adjustment.delete'), deletion('PERIODIC_ADJUSTMENT_DELETE_BLOCKED', false, (s, c, a, id) => s.deletePeriodicAdjustment(c, a, id)));
recordDeletionRouter.delete('/bank-import-batches/:id', ...write, requireCapability('bank.import.delete'), deletion('BANK_IMPORT_DELETE_BLOCKED', false, (s, c, a, id) => s.deleteBankImportBatch(c, a, id)));
recordDeletionRouter.delete('/counterparties/:id', ...write, requireCapability('counterparty.delete'), deletion('COUNTERPARTY_DELETE_BLOCKED', true, (s, c, a, id, v) => s.deleteCounterparty(c, a, id, v)));
recordDeletionRouter.delete('/partners/:id', ...write, requireCapability('partner.delete'), deletion('PARTNER_DELETE_BLOCKED', true, (s, c, a, id, v) => s.deletePartner(c, a, id, v)));
