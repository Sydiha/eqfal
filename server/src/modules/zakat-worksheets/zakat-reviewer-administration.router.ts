import { NextFunction, Request, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { ZakatForbiddenError, ZakatNotFoundError, ZakatValidationError } from './zakat-worksheet.service';
import { ZakatReviewerAdministrationService } from './zakat-reviewer-administration.service';

export const zakatReviewerAdministrationRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exact = (body: unknown, keys: string[]): body is Record<string, unknown> => body !== null && typeof body === 'object'
  && !Array.isArray(body) && Object.keys(body).length === keys.length && Object.keys(body).every((key) => keys.includes(key));
const actor = (req: Request) => getAuthenticatedContext(req)!.user.id;
const company = (req: Request) => getAuthenticatedContext(req)!.activeCompanyId!;
const run = (fn: (service: ZakatReviewerAdministrationService, req: Request) => Promise<unknown>, status = 200) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
    void fn(new ZakatReviewerAdministrationService(pool), req).then((value) => status === 204 ? res.status(204).end() : res.status(status).json(value)).catch((error: unknown) => {
      if (error instanceof ZakatForbiddenError) res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
      else if (error instanceof ZakatNotFoundError) res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      else if (error instanceof ZakatValidationError) res.status(400).json({ error: error.message, code: error.code });
      else if ((error as { code?: string }).code === '23505') res.status(409).json({ error: 'An active appointment already exists', code: 'ZAKAT_REVIEWER_ALREADY_APPOINTED' });
      else if ((error as { code?: string }).code === '23514') res.status(409).json({ error: 'The appointment changed. Reload the reviewer list and retry.', code: 'ZAKAT_REVIEWER_STATE_CHANGED' });
      else next(error);
    });
  };
const read = [requireAuth, requireActiveCompany, requireCapability('zakat.reviewer.manage')];
const write = [requireSameOrigin, ...read];

zakatReviewerAdministrationRouter.get('/zakat-reviewers', ...read, run((service, req) => service.list(company(req), actor(req))));
zakatReviewerAdministrationRouter.post('/zakat-reviewers', ...write, (req, res, next) => {
  const body: unknown = req.body;
  if (!exact(body, ['user_id', 'appointment_reference', 'identity_verified']) || typeof body.user_id !== 'string' || !UUID.test(body.user_id)
    || typeof body.appointment_reference !== 'string' || !body.appointment_reference.trim() || body.appointment_reference.trim().length > 500
    || body.identity_verified !== true) {
    res.status(400).json({ error: 'A company member, appointment reference, and explicit identity verification are required', code: 'ZAKAT_VALIDATION' }); return;
  }
  const requestBody = body as Record<string, unknown>;
  run((service, request) => service.appoint(company(request), actor(request), requestBody.user_id as string, (requestBody.appointment_reference as string).trim()), 201)(req, res, next);
});
zakatReviewerAdministrationRouter.post('/zakat-reviewers/:appointmentId/revoke', ...write, (req, res, next) => {
  const body: unknown = req.body;
  if (!UUID.test(req.params.appointmentId ?? '') || !exact(body, ['reason']) || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 2000) {
    res.status(400).json({ error: 'A revocation reason is required', code: 'ZAKAT_VALIDATION' }); return;
  }
  const requestBody = body as Record<string, unknown>;
  run((service, request) => service.revoke(company(request), actor(request), request.params.appointmentId!, (requestBody.reason as string).trim()))(req, res, next);
});
