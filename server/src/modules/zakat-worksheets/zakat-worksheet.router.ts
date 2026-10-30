import { Request, Response, NextFunction, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { ZakatConflictError, ZakatNotFoundError, ZakatValidationError, ZakatWorksheetService } from './zakat-worksheet.service';

// G6-1 routes. They reuse the existing tax_workpaper.* and partner.ownership.* capabilities (no new capability is introduced).
export const zakatWorksheetRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^(?:0|[1-9]\d{0,15})\.\d{2}$/;
const plain = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const ctx = (r: Request) => getAuthenticatedContext(r)! as NonNullable<ReturnType<typeof getAuthenticatedContext>> & { activeCompanyId: string };
const service = (res: Response) => { if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return null; } return new ZakatWorksheetService(pool); };
const handle = (e: unknown, res: Response, next: NextFunction) => {
  if (e instanceof ZakatNotFoundError) res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  else if (e instanceof ZakatValidationError) res.status(400).json({ error: e.message, code: e.code });
  else if (e instanceof ZakatConflictError) res.status(409).json({ error: e.message, code: e.code });
  else next(e);
};
const base = [requireAuth, requireActiveCompany];
const write = [requireSameOrigin, ...base];
const versionOf = (b: unknown, key = 'version') => (plain(b) && Number.isInteger(b[key]) && Number(b[key]) > 0 ? Number(b[key]) : null);
const textOf = (v: unknown, max: number, nullable = true) => (v === null || v === undefined ? (nullable ? null : undefined) : typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v : undefined);
const only = (b: Record<string, unknown>, keys: string[]) => Object.keys(b).every((k) => keys.includes(k));

type Handler = (s: ZakatWorksheetService, req: Request, company: string, user: string) => Promise<unknown>;
/** Wraps a handler: validates the fiscal-year id, builds the service, maps domain errors. */
const run = (status: number, fn: Handler, yearParam = true) => (req: Request, res: Response, next: NextFunction) => {
  if (yearParam && !UUID.test(String(req.params['fiscalYearId']))) { res.status(400).json({ error: 'Invalid fiscal year', code: 'ZAKAT_VALIDATION' }); return; }
  const s = service(res); if (!s) return;
  void Promise.resolve().then(() => fn(s, req, ctx(req).activeCompanyId, ctx(req).user.id)).then((out) => { if (status === 204) res.status(204).end(); else res.status(status).json(out); }).catch((e) => handle(e, res, next));
};
const bad = (res: Response) => res.status(400).json({ error: 'Invalid request', code: 'ZAKAT_VALIDATION' });
const guard = (check: (b: Record<string, unknown>) => boolean, fn: Handler, status = 200) => (req: Request, res: Response, next: NextFunction) => {
  if (!UUID.test(String(req.params['fiscalYearId'])) || !plain(req.body) || !check(req.body)) { bad(res); return; }
  run(status, fn)(req, res, next);
};
const fy = (req: Request) => String(req.params['fiscalYearId']);

zakatWorksheetRouter.get('/zakat-worksheets/:fiscalYearId', ...base, requireCapability('tax_workpaper.view'), run(200, (s, req, c) => s.get(c, fy(req))));
zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId', ...write, requireCapability('tax_workpaper.create'), run(201, (s, req, c, u) => s.create(c, fy(req), u)));
zakatWorksheetRouter.patch('/zakat-worksheets/:fiscalYearId/declarations', ...write, requireCapability('tax_workpaper.edit'),
  guard((b) => only(b, ['non_financing_confirmed', 'accounting_records_confirmed', 'version']) && typeof b['non_financing_confirmed'] === 'boolean' && typeof b['accounting_records_confirmed'] === 'boolean' && versionOf(b) !== null,
    (s, req, c, u) => s.setDeclarations(c, fy(req), u, { non_financing_confirmed: req.body.non_financing_confirmed, accounting_records_confirmed: req.body.accounting_records_confirmed, version: versionOf(req.body)! })));
zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/refresh', ...write, requireCapability('tax_workpaper.edit'),
  guard((b) => only(b, ['version']) && versionOf(b) !== null, (s, req, c, u) => s.refresh(c, fy(req), u, versionOf(req.body)!)));

zakatWorksheetRouter.put('/zakat-worksheets/:fiscalYearId/classifications/:accountId', ...write, requireCapability('tax_workpaper.edit'),
  guard((b) => only(b, ['zakat_type', 'reg_article', 'evidence_document_id', 'note', 'version']) && typeof b['zakat_type'] === 'string' && textOf(b['reg_article'], 100, false) !== undefined && b['reg_article'] !== null
    && (b['evidence_document_id'] === null || b['evidence_document_id'] === undefined || (typeof b['evidence_document_id'] === 'string' && UUID.test(b['evidence_document_id']))) && textOf(b['note'], 2000) !== undefined && versionOf(b) !== null,
  (s, req, c, u) => { if (!UUID.test(String(req.params['accountId']))) throw new ZakatValidationError('Invalid account', 'ZAKAT_VALIDATION'); const b = req.body; return s.classify(c, fy(req), String(req.params['accountId']), u, { zakat_type: String(b.zakat_type), reg_article: String(b.reg_article), evidence_document_id: (b.evidence_document_id as string | null | undefined) ?? null, note: (b.note as string | null | undefined) ?? null, version: versionOf(b)! }); }));
zakatWorksheetRouter.delete('/zakat-worksheets/:fiscalYearId/classifications/:accountId', ...write, requireCapability('tax_workpaper.edit'),
  guard((b) => only(b, ['version']) && versionOf(b) !== null, (s, req, c, u) => { if (!UUID.test(String(req.params['accountId']))) throw new ZakatValidationError('Invalid account', 'ZAKAT_VALIDATION'); return s.unclassify(c, fy(req), String(req.params['accountId']), u, versionOf(req.body)!); }));

const adjustmentOk = (b: Record<string, unknown>, keys: string[]) => only(b, keys) && textOf(b['description'], 500, false) !== undefined && b['description'] !== null && ['add', 'deduct'].includes(String(b['direction']))
  && typeof b['amount'] === 'string' && AMOUNT.test(b['amount']) && b['amount'] !== '0.00' && textOf(b['reg_article'], 100, false) !== undefined && b['reg_article'] !== null
  && (b['evidence_document_id'] === null || b['evidence_document_id'] === undefined || (typeof b['evidence_document_id'] === 'string' && UUID.test(b['evidence_document_id']))) && textOf(b['evidence_note'], 2000) !== undefined && versionOf(b) !== null;
const adjustmentArgs = (b: Record<string, unknown>) => ({ description: String(b['description']), direction: String(b['direction']), amount: String(b['amount']), reg_article: String(b['reg_article']), evidence_document_id: (b['evidence_document_id'] as string | null | undefined) ?? null, evidence_note: (b['evidence_note'] as string | null | undefined) ?? null, version: versionOf(b)! });
zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/adjustments', ...write, requireCapability('tax_workpaper.adjustment.create'),
  guard((b) => adjustmentOk(b, ['description', 'direction', 'amount', 'reg_article', 'evidence_document_id', 'evidence_note', 'version']), (s, req, c, u) => s.addAdjustment(c, fy(req), u, adjustmentArgs(req.body)), 201));
zakatWorksheetRouter.patch('/zakat-worksheets/:fiscalYearId/adjustments/:id', ...write, requireCapability('tax_workpaper.adjustment.edit'),
  guard((b) => adjustmentOk(b, ['description', 'direction', 'amount', 'reg_article', 'evidence_document_id', 'evidence_note', 'version', 'adjustment_version']) && versionOf(b, 'adjustment_version') !== null,
    (s, req, c, u) => { if (!UUID.test(String(req.params['id']))) throw new ZakatValidationError('Invalid adjustment', 'ZAKAT_VALIDATION'); return s.changeAdjustment(c, fy(req), String(req.params['id']), u, { ...adjustmentArgs(req.body), adjustment_version: versionOf(req.body, 'adjustment_version')! }); }));
zakatWorksheetRouter.delete('/zakat-worksheets/:fiscalYearId/adjustments/:id', ...write, requireCapability('tax_workpaper.adjustment.delete'),
  guard((b) => only(b, ['version']) && versionOf(b) !== null, (s, req, c, u) => { if (!UUID.test(String(req.params['id']))) throw new ZakatValidationError('Invalid adjustment', 'ZAKAT_VALIDATION'); return s.removeAdjustment(c, fy(req), String(req.params['id']), u, versionOf(req.body)!); }));

const versionOnly = (b: Record<string, unknown>) => only(b, ['version']) && versionOf(b) !== null;
const reasonBody = (b: Record<string, unknown>) => only(b, ['version', 'reason']) && versionOf(b) !== null && textOf(b['reason'], 2000, false) !== undefined && b['reason'] !== null;
zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/submit', ...write, requireCapability('tax_workpaper.submit'), guard(versionOnly, (s, req, c, u) => s.transition(c, fy(req), u, 'submit', versionOf(req.body)!)));
zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/review', ...write, requireCapability('tax_workpaper.review'), guard(versionOnly, (s, req, c, u) => s.transition(c, fy(req), u, 'review', versionOf(req.body)!)));
zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/approve', ...write, requireCapability('tax_workpaper.approve'), guard(versionOnly, (s, req, c, u) => s.transition(c, fy(req), u, 'approve', versionOf(req.body)!)));
zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/return', ...write, requireCapability('tax_workpaper.review'), guard(reasonBody, (s, req, c, u) => s.returnToDraft(c, fy(req), u, versionOf(req.body)!, String(req.body.reason))));
zakatWorksheetRouter.post('/zakat-worksheets/:fiscalYearId/revise', ...write, requireCapability('tax_workpaper.approve'), guard(reasonBody, (s, req, c, u) => s.revise(c, fy(req), u, versionOf(req.body)!, String(req.body.reason)), 201));

// Effective-dated ownership eligibility evidence (never inferred from missing partner attributes).
zakatWorksheetRouter.get('/zakat-eligibility', ...base, requireCapability('tax_workpaper.view'), run(200, async (s, req, c) => {
  const partner = req.query['partner_id'];
  if (partner !== undefined && !(typeof partner === 'string' && UUID.test(partner))) throw new ZakatValidationError('Invalid partner', 'ZAKAT_VALIDATION');
  return { eligibility: await s.listEligibility(c, partner as string | undefined) };
}, false));
zakatWorksheetRouter.post('/zakat-eligibility', ...write, requireCapability('partner.ownership.create'), (req, res, next) => {
  const b = req.body;
  const ok = plain(b) && only(b, ['partner_id', 'ownership_class', 'effective_from', 'effective_to', 'evidence_document_id', 'entity_ultimate_ownership_note', 'note'])
    && typeof b['partner_id'] === 'string' && UUID.test(b['partner_id']) && typeof b['ownership_class'] === 'string' && typeof b['effective_from'] === 'string' && DATE.test(b['effective_from'])
    && (b['effective_to'] === null || b['effective_to'] === undefined || (typeof b['effective_to'] === 'string' && DATE.test(b['effective_to']))) && typeof b['evidence_document_id'] === 'string' && UUID.test(b['evidence_document_id'])
    && textOf(b['entity_ultimate_ownership_note'], 2000) !== undefined && textOf(b['note'], 1000) !== undefined;
  if (!ok) { bad(res); return; }
  run(201, async (s, r, c, u) => ({ eligibility: await s.createEligibility(c, u, { partner_id: String(b.partner_id), ownership_class: String(b.ownership_class), effective_from: String(b.effective_from), effective_to: (b.effective_to as string | null | undefined) ?? null, evidence_document_id: String(b.evidence_document_id), entity_ultimate_ownership_note: (b.entity_ultimate_ownership_note as string | null | undefined) ?? null, note: (b.note as string | null | undefined) ?? null }) }), false)(req, res, next);
});
const eligibilityAction = (cap: string, path: string, check: (b: Record<string, unknown>) => boolean, fn: (s: ZakatWorksheetService, c: string, u: string, id: string, b: Record<string, unknown>) => Promise<unknown>, method: 'post' | 'delete' = 'post') =>
  zakatWorksheetRouter[method](`/zakat-eligibility/:id${path}`, ...write, requireCapability(cap), (req: Request, res: Response, next: NextFunction) => {
    if (!UUID.test(String(req.params['id'])) || !plain(req.body) || !check(req.body)) { bad(res); return; }
    run(method === 'delete' ? 204 : 200, async (s, r, c, u) => ({ eligibility: await fn(s, c, u, String(r.params['id']), r.body) }), false)(req, res, next);
  });
eligibilityAction('partner.ownership.confirm', '/confirm', versionOnly, (s, c, u, id, b) => s.confirmEligibility(c, u, id, versionOf(b)!));
eligibilityAction('partner.ownership.edit', '/end', (b) => only(b, ['version', 'effective_to']) && versionOf(b) !== null && typeof b['effective_to'] === 'string' && DATE.test(b['effective_to']), (s, c, u, id, b) => s.endEligibility(c, u, id, versionOf(b)!, String(b['effective_to'])));
eligibilityAction('partner.ownership.edit', '', versionOnly, (s, c, u, id, b) => s.removeEligibility(c, u, id, versionOf(b)!), 'delete');
