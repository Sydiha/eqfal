import { NextFunction, Request, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { WhtReviewConflictError, WhtReviewNotFoundError, WhtReviewService, WhtReviewValidationError } from './wht-review.service';

export const whtReviewRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mutableFields = ['source_type', 'source_id', 'counterparty_id', 'non_resident_assessment', 'payment_service_category', 'basis_reference', 'reviewer_note', 'professional_review_required'] as const;
const base = [requireAuth, requireActiveCompany];
const write = [requireSameOrigin, ...base];
const context = (request: Request) => getAuthenticatedContext(request)!;
const service = () => new WhtReviewService(pool!);
const route = (handler: (request: Request, response: Response, next: NextFunction) => unknown) =>
  (request: Request, response: Response, next: NextFunction) => void Promise.resolve(handler(request, response, next)).catch(next);

const fail = (error: unknown, response: Response, next: NextFunction) => {
  if (error instanceof WhtReviewNotFoundError) response.status(404).json({ error: 'Not found' });
  else if (error instanceof WhtReviewValidationError) response.status(400).json({ error: error.message });
  else if (error instanceof WhtReviewConflictError) response.status(409).json({ error: error.message });
  else next(error);
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value: Record<string, unknown>, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const fieldIsValid = (field: typeof mutableFields[number], value: unknown) => {
  switch (field) {
    case 'source_type': return ['document', 'obligation', 'bank_transaction'].includes(String(value));
    case 'source_id': return typeof value === 'string' && UUID.test(value);
    case 'counterparty_id': return value === null || (typeof value === 'string' && UUID.test(value));
    case 'non_resident_assessment': return ['unknown', 'resident', 'non_resident'].includes(String(value));
    case 'payment_service_category': return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 200;
    case 'basis_reference': return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 2000;
    case 'reviewer_note': return value === null || (typeof value === 'string' && value.length <= 2000);
    case 'professional_review_required': return typeof value === 'boolean';
  }
};
const validCreate = (body: unknown) => isObject(body)
  && mutableFields.every(field => ['counterparty_id', 'reviewer_note'].includes(field) || hasOwn(body, field))
  && Object.keys(body).every(field => (mutableFields as readonly string[]).includes(field))
  && mutableFields.every(field => !hasOwn(body, field) || fieldIsValid(field, body[field]));
const validPatch = (body: unknown) => {
  if (!isObject(body) || !Number.isInteger(body.version) || Number(body.version) < 1) return false;
  const keys = Object.keys(body);
  const changes = keys.filter(field => field !== 'version');
  return changes.length > 0
    && keys.every(field => field === 'version' || (mutableFields as readonly string[]).includes(field))
    && changes.every(field => fieldIsValid(field as typeof mutableFields[number], body[field]));
};
const validVersion = (body: unknown) => isObject(body) && Number.isInteger(body.version) && Number(body.version) >= 1;

whtReviewRouter.get('/wht-reviews/:fiscalYearId', ...base, requireCapability('wht_review.view'), route(async (request, response) => {
  response.json({ reviews: await service().list(context(request).activeCompanyId!, request.params.fiscalYearId) });
}));
whtReviewRouter.post('/wht-reviews/:fiscalYearId', ...write, requireCapability('wht_review.create'), route(async (request, response, next) => {
  if (!validCreate(request.body)) { response.status(400).json({ error: 'Invalid request' }); return; }
  try { response.status(201).json({ review: await service().create(context(request).activeCompanyId!, request.params.fiscalYearId, context(request).user.id, request.body) }); }
  catch (error) { fail(error, response, next); }
}));
whtReviewRouter.patch('/wht-reviews/:fiscalYearId/:id', ...write, requireCapability('wht_review.edit'), route(async (request, response, next) => {
  if (!validPatch(request.body)) { response.status(400).json({ error: 'Invalid request' }); return; }
  try { response.json({ review: await service().update(context(request).activeCompanyId!, request.params.fiscalYearId, request.params.id, context(request).user.id, request.body) }); }
  catch (error) { fail(error, response, next); }
}));
whtReviewRouter.post('/wht-reviews/:fiscalYearId/:id/submit', ...write, requireCapability('wht_review.submit'), route(async (request, response, next) => {
  if (!validVersion(request.body) || Object.keys(request.body).some(key => key !== 'version')) { response.status(400).json({ error: 'Invalid request' }); return; }
  try { response.json({ review: await service().transition(context(request).activeCompanyId!, request.params.fiscalYearId, request.params.id, context(request).user.id, request.body.version, 'submit') }); }
  catch (error) { fail(error, response, next); }
}));
whtReviewRouter.post('/wht-reviews/:fiscalYearId/:id/review', ...write, requireCapability('wht_review.review'), route(async (request, response, next) => {
  if (!validVersion(request.body) || !['not_applicable', 'applicable'].includes(request.body.result) || Object.keys(request.body).some(key => !['version', 'result', 'reviewer_note'].includes(key)) || (hasOwn(request.body, 'reviewer_note') && !fieldIsValid('reviewer_note', request.body.reviewer_note))) { response.status(400).json({ error: 'Invalid request' }); return; }
  try { response.json({ review: await service().transition(context(request).activeCompanyId!, request.params.fiscalYearId, request.params.id, context(request).user.id, request.body.version, 'review', request.body.result, request.body.reviewer_note) }); }
  catch (error) { fail(error, response, next); }
}));
