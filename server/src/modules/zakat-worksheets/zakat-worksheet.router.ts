import { NextFunction, Request, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { ZakatConflictError, ZakatNotFoundError, ZakatValidationError } from './zakat.constants';
import { ZakatWorksheetService } from './zakat-worksheet.service';

export const zakatWorksheetRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMOUNT = /^(?:0|[1-9]\d{0,15})\.\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
type Body = Record<string, unknown>;
const plain = (v: unknown): v is Body => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const only = (b: Body, keys: string[]) => Object.keys(b).every((k) => keys.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optText = (v: unknown, max: number) => v === undefined || v === null || text(v, max);
const ver = (b: Body, key = 'version') => (Number.isInteger(b[key]) && Number(b[key]) > 0 ? Number(b[key]) : null);
const ctx = (r: Request) => getAuthenticatedContext(r)! as NonNullable<ReturnType<typeof getAuthenticatedContext>> & { activeCompanyId: string };
const base = [requireAuth, requireActiveCompany];
const write = [requireSameOrigin, ...base];
const bad = (res: Response) => res.status(400).json({ error: 'Invalid request', code: 'ZAKAT_INVALID_REQUEST' });

const handle = (e: unknown, res: Response, next: NextFunction) => {
  if (e instanceof ZakatNotFoundError) res.status(404).json({ error: 'Not found', code: 'ZAKAT_NOT_FOUND' });
  else if (e instanceof ZakatValidationError) res.status(422).json({ error: e.message, code: e.code, blockers: e.blockers });
  else if (e instanceof ZakatConflictError) res.status(409).json({ error: e.message, code: e.code, blockers: e.blockers });
  else if ((e as { code?: string }).code === '23505') res.status(409).json({ error: 'Conflicting concurrent change', code: 'ZAKAT_CONFLICT', blockers: [] });
  else next(e);
};
type Handler = (req: Request, res: Response, svc: ZakatWorksheetService) => Promise<void>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  void fn(req, res, new ZakatWorksheetService(pool)).catch((e) => handle(e, res, next));
};
const company = (req: Request) => ctx(req).activeCompanyId;
const user = (req: Request) => ctx(req).user.id;
const year = (req: Request) => req.params['fiscalYearId'] as string;
const idsOk = (req: Request, ...names: string[]) => UUID.test(year(req)) && names.every((n) => UUID.test(req.params[n] as string));

zakatWorksheetRouter.get('/zakat-worksheets/:fiscalYearId', ...base, requireCapability('tax_workpaper.view'), route(async (req, res, s) => {
  if (!idsOk(req)) return void bad(res);
  res.json(await s.get(company(req), year(req)));
}));

zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId', ...write, requireCapability('tax_workpaper.create'), route(async (req, res, s) => {
  const b = req.body;
  if (!idsOk(req) || !plain(b) || !only(b, ['non_financing_entity_declared']) || typeof b['non_financing_entity_declared'] !== 'boolean') return void bad(res);
  res.status(201).json(await s.createInitial(company(req), year(req), user(req), b['non_financing_entity_declared']));
}));

zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/refresh', ...write, requireCapability('tax_workpaper.edit'), route(async (req, res, s) => {
  const b = req.body; const v = plain(b) ? ver(b) : null;
  if (!idsOk(req) || v === null || !only(b, ['version'])) return void bad(res);
  res.json(await s.refresh(company(req), year(req), user(req), v));
}));

zakatWorksheetRouter.put('/zakat-worksheets/:fiscalYearId/classifications/:accountId', ...write, requireCapability('tax_workpaper.edit'), route(async (req, res, s) => {
  const b = req.body; const v = plain(b) ? ver(b) : null;
  if (!idsOk(req, 'accountId') || v === null || !only(b, ['zakat_class', 'reg_article', 'evidence_document_id', 'note', 'version']) || !text(b['zakat_class'], 80) || !text(b['reg_article'], 100)
    || !(b['evidence_document_id'] == null || (typeof b['evidence_document_id'] === 'string' && UUID.test(b['evidence_document_id']))) || !optText(b['note'], 2000)) return void bad(res);
  res.json(await s.setClassification(company(req), year(req), req.params['accountId']!, user(req), { zakat_class: b['zakat_class'], reg_article: b['reg_article'], evidence_document_id: (b['evidence_document_id'] as string | null | undefined) ?? null, note: (b['note'] as string | null | undefined) ?? null, version: v }));
}));

zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/classifications/:accountId/confirm', ...write, requireCapability('tax_workpaper.review'), route(async (req, res, s) => {
  const b = req.body; const v = plain(b) ? ver(b) : null;
  if (!idsOk(req, 'accountId') || v === null || !only(b, ['version'])) return void bad(res);
  res.json(await s.confirmClassification(company(req), year(req), req.params['accountId']!, user(req), v));
}));

const adjustmentBody = (b: unknown, partial: boolean) => {
  if (!plain(b) || ver(b) === null || !only(b, ['description', 'direction', 'amount', 'reg_article', 'evidence_document_id', 'note', 'professional_review_required', 'version'])) return null;
  const has = (k: string) => k in b;
  if ((!partial || has('description')) && !text(b['description'], 500)) return null;
  if ((!partial || has('direction')) && !['add', 'deduct'].includes(String(b['direction']))) return null;
  if ((!partial || has('amount')) && !(typeof b['amount'] === 'string' && AMOUNT.test(b['amount']) && b['amount'] !== '0.00')) return null;
  if ((!partial || has('reg_article')) && !text(b['reg_article'], 100)) return null;
  if ((!partial || has('evidence_document_id')) && !(typeof b['evidence_document_id'] === 'string' && UUID.test(b['evidence_document_id']))) return null;
  if (has('note') && !optText(b['note'], 2000)) return null;
  if (has('professional_review_required') && typeof b['professional_review_required'] !== 'boolean') return null;
  return b;
};
zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/adjustments', ...write, requireCapability('tax_workpaper.edit'), route(async (req, res, s) => {
  const b = adjustmentBody(req.body, false);
  if (!idsOk(req) || !b) return void bad(res);
  res.status(201).json(await s.addAdjustment(company(req), year(req), user(req), { description: String(b['description']).trim(), direction: String(b['direction']), amount: String(b['amount']), reg_article: String(b['reg_article']).trim(), evidence_document_id: String(b['evidence_document_id']), note: (b['note'] as string | null | undefined) ?? null, professional_review_required: Boolean(b['professional_review_required']), version: Number(b['version']) }));
}));
zakatWorksheetRouter.patch('/zakat-worksheets/:fiscalYearId/adjustments/:id', ...write, requireCapability('tax_workpaper.edit'), route(async (req, res, s) => {
  const b = adjustmentBody(req.body, true);
  if (!idsOk(req, 'id') || !b) return void bad(res);
  const { version, ...rest } = b as Body;
  res.json(await s.changeAdjustment(company(req), year(req), req.params['id']!, user(req), { ...(rest as object), version: Number(version) }));
}));
zakatWorksheetRouter.delete('/zakat-worksheets/:fiscalYearId/adjustments/:id', ...write, requireCapability('tax_workpaper.edit'), route(async (req, res, s) => {
  const b = req.body; const v = plain(b) ? ver(b) : null;
  if (!idsOk(req, 'id') || v === null || !only(b, ['version'])) return void bad(res);
  res.json(await s.removeAdjustment(company(req), year(req), req.params['id']!, user(req), v));
}));

for (const [action, cap] of [['submit-review', 'tax_workpaper.submit'], ['review', 'tax_workpaper.review'], ['approve', 'tax_workpaper.approve']] as const) {
  zakatWorksheetRouter.post(`/zakat-worksheets/:fiscalYearId/${action}`, ...write, requireCapability(cap), route(async (req, res, s) => {
    const b = req.body; const v = plain(b) ? ver(b) : null;
    if (!idsOk(req) || v === null || !only(b, ['version'])) return void bad(res);
    res.json(await s.transition(company(req), year(req), user(req), action, v));
  }));
}
zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/return-to-draft', ...write, requireCapability('tax_workpaper.edit'), route(async (req, res, s) => {
  const b = req.body; const v = plain(b) ? ver(b) : null;
  if (!idsOk(req) || v === null || !only(b, ['version', 'reason']) || !text(b['reason'], 1000)) return void bad(res);
  res.json(await s.returnToDraft(company(req), year(req), user(req), v, b['reason']));
}));
zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/revisions', ...write, requireCapability('tax_workpaper.create'), route(async (req, res, s) => {
  const b = req.body; const v = plain(b) ? ver(b) : null;
  if (!idsOk(req) || v === null || !only(b, ['version', 'reason']) || !text(b['reason'], 1000)) return void bad(res);
  res.status(201).json(await s.newRevision(company(req), year(req), user(req), v, b['reason']));
}));

// Effective-dated ownership eligibility (company-level; evidence mandatory; confirmation needs the review capability).
zakatWorksheetRouter.post('/zakat-eligibility', ...write, requireCapability('tax_workpaper.review'), route(async (req, res, s) => {
  const b = req.body;
  if (!plain(b) || !only(b, ['partner_id', 'ownership_class', 'effective_from', 'effective_to', 'evidence_document_id', 'ultimate_ownership_note'])
    || !(typeof b['partner_id'] === 'string' && UUID.test(b['partner_id'])) || !text(b['ownership_class'], 40) || !(typeof b['effective_from'] === 'string' && DATE.test(b['effective_from']))
    || !(b['effective_to'] == null || (typeof b['effective_to'] === 'string' && DATE.test(b['effective_to']))) || !(typeof b['evidence_document_id'] === 'string' && UUID.test(b['evidence_document_id'])) || !optText(b['ultimate_ownership_note'], 2000)) return void bad(res);
  res.status(201).json({ eligibility: await s.recordEligibility(company(req), user(req), { partner_id: b['partner_id'], ownership_class: b['ownership_class'], effective_from: b['effective_from'], effective_to: (b['effective_to'] as string | null | undefined) ?? null, evidence_document_id: b['evidence_document_id'], ultimate_ownership_note: (b['ultimate_ownership_note'] as string | null | undefined) ?? null }) });
}));
zakatWorksheetRouter.post('/zakat-eligibility/:id/revoke', ...write, requireCapability('tax_workpaper.review'), route(async (req, res, s) => {
  const b = req.body; const v = plain(b) ? ver(b) : null;
  if (!UUID.test(req.params['id'] as string) || v === null || !only(b, ['version', 'reason']) || !text(b['reason'], 1000)) return void bad(res);
  res.json({ eligibility: await s.revokeEligibility(company(req), req.params['id']!, user(req), b['reason'], v) });
}));
