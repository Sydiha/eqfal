import express, { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { LedgerCutoverService, parseCutoverInput, parseLegacyReplayInput } from '../accounting/ledger-cutover';
import { LedgerSourceAuthorityError, LedgerSourceAuthorityNotFoundError, LedgerSourceAuthorityService } from '../accounting/ledger-source-authority';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { decodeUploadFilename, detectUploadFormat, readRawSheet } from '../banking/bank.router';
import { parseTrialBalanceTable, parseTbMapping, TB_MAX_LINES } from '../accounting/cutover-file-import';
import { CutoverSupplementService, parseSupplementInput } from '../accounting/cutover-supplements';

// C1B-2: read plus DRAFT create/void. A draft has no accounting effect.
// C1B-3b: preview and activate (the ONLY path to an active range): the cut-over trial balance becomes one posted `cutover_balance` journal and
// the range turns active in the same transaction. Requires the independent critical capability source_authority.activate (no role holds it by default).
export const ledgerSourceAuthorityRouter = Router();
const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next: NextFunction) => {
  void handler(req, res).catch((error) => {
    if (error instanceof LedgerSourceAuthorityNotFoundError) { res.status(404).json({ error: 'Not found' }); return; }
    if (error instanceof LedgerSourceAuthorityError) {
      res.status(error.code === 'AUTHORITY_RANGE_INVALID' || error.code === 'CUTOVER_LINES_INVALID' || error.code === 'CUTOVER_EVIDENCE_REQUIRED' || error.code === 'SUPPLEMENT_LINES_INVALID' ? 400 : 409).json({ error: error.message, code: error.code, ...('detail' in error && (error as { detail?: unknown }).detail !== undefined ? { detail: (error as { detail?: unknown }).detail } : {}) });
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
  const ctx = getAuthenticatedContext(req)!;
  if (!input) {
    // A pre-S1 body can only replay an activation that already completed; it never activates anything.
    const legacy = parseLegacyReplayInput(req.body);
    if (!legacy) { res.status(400).json({ error: 'Invalid request', code: 'CUTOVER_LINES_INVALID' }); return; }
    res.status(200).json(await new LedgerCutoverService(pool).replayLegacy(ctx.activeCompanyId!, id, legacy));
    return;
  }
  const result = await new LedgerCutoverService(pool).activate(ctx.activeCompanyId!, ctx.user.id, id, input);
  res.status(result.replayed ? 200 : 201).json(result);
}));

// I1: read-only trial balance file parser for the cut-over form. Writes nothing; the result only fills the form, which still goes through preview/activate.
const tbUpload = express.raw({ type: () => true, limit: 2 * 1024 * 1024 });

ledgerSourceAuthorityRouter.post('/ledger-source-authority/:id/cutover/parse-file', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(ACTIVATE), tbUpload, route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const id = req.params['id'] ?? '';
  if (!uuid(id)) { res.status(404).json({ error: 'Not found' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  const companyId = ctx.activeCompanyId!;
  const filename = decodeUploadFilename(req.headers['x-file-name']);
  const mime = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const format = filename ? detectUploadFormat(filename, mime, data) : null;
  const mapping = parseTbMapping(req.headers['x-tb-mapping']);
  if (!format || mapping === null) { res.status(400).json({ error: 'Invalid trial balance file', code: 'TB_FILE_INVALID' }); return; }
  const range = (await pool.query<{ to_date: string; status: string }>('SELECT to_date::text,status FROM ledger_source_authority WHERE id=$1 AND company_id=$2', [id, companyId])).rows[0];
  if (!range) { res.status(404).json({ error: 'Not found' }); return; }
  if (range.status !== 'draft') { res.status(409).json({ error: 'This configuration is not a draft', code: 'AUTHORITY_NOT_DRAFT' }); return; }
  let sheet;
  try { sheet = readRawSheet(format, data); } catch { res.status(400).json({ error: 'Invalid trial balance file', code: 'TB_FILE_INVALID' }); return; }
  if (sheet.rows.length > TB_MAX_LINES + 60) { res.status(400).json({ error: 'Too many rows', code: 'TB_TOO_MANY_ROWS' }); return; }
  const accounts = (await pool.query<{ id: string; code: string; is_active: boolean }>('SELECT id,code,is_active FROM accounts WHERE company_id=$1', [companyId])).rows;
  const cur = (await pool.query<{ functional_currency: string }>(
    `SELECT functional_currency FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=($2::date+1) AND (effective_to IS NULL OR effective_to>=($2::date+1))`, [companyId, range.to_date])).rows;
  const result = parseTrialBalanceTable(sheet.rows, sheet.formulaCells, accounts, { ...(mapping ? { mapping } : {}), functionalCurrency: cur.length === 1 ? cur[0]!.functional_currency : null });
  if (result.status === 'parsed' && sheet.sheetCount > 1) result.errors.push({ code: 'TB_MULTIPLE_SHEETS' });
  res.json({ ...result, functional_currency: cur.length === 1 ? cur[0]!.functional_currency : null, cutover_date: range.to_date });
}));

// Cutover S2: pre-cut-over historical supplements (cash flows, equity movements). Read with source_authority.view; drafts need the independent
// capability source_authority.supplement_manage; approval needs source_authority.supplement_approve. No default role holds either (migration 091).
// The same user may enter and approve only when holding both capabilities; each action is audited separately. Every query is company-scoped.
const SUPPLEMENT_MANAGE = 'source_authority.supplement_manage';
const SUPPLEMENT_APPROVE = 'source_authority.supplement_approve';
const expectedVersion = (body: unknown): number | null => {
  const v = (body as Record<string, unknown> | null)?.['expected_row_version'];
  return Number.isInteger(v) && (v as number) >= 1 ? (v as number) : null;
};
const supplementRoute = (handler: (req: Request, res: Response, ids: { id: string; versionId: string | null }) => Promise<void>): RequestHandler => route(async (req, res) => {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const id = req.params['id'] ?? '', versionId = req.params['versionId'] ?? null;
  if (!uuid(id) || (versionId !== null && !uuid(versionId))) { res.status(404).json({ error: 'Not found' }); return; }
  await handler(req, res, { id, versionId });
});

ledgerSourceAuthorityRouter.get('/ledger-source-authority/:id/supplements', requireAuth, requireActiveCompany, requireCapability('source_authority.view'), supplementRoute(async (req, res, { id }) => {
  res.json(await new CutoverSupplementService(pool!).list(getAuthenticatedContext(req)!.activeCompanyId!, id));
}));

ledgerSourceAuthorityRouter.post('/ledger-source-authority/:id/supplements/:kind/drafts', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(SUPPLEMENT_MANAGE), supplementRoute(async (req, res, { id }) => {
  const kind = req.params['kind'];
  if (kind !== 'cash_flow' && kind !== 'equity') { res.status(404).json({ error: 'Not found' }); return; }
  if (req.body?.['confirm'] !== true) { res.status(400).json({ error: 'Explicit confirmation is required', code: 'CONFIRMATION_REQUIRED' }); return; }
  const input = parseSupplementInput(kind, req.body);
  if (!input) { res.status(400).json({ error: 'Invalid request', code: 'SUPPLEMENT_LINES_INVALID' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  res.status(201).json(await new CutoverSupplementService(pool!).createDraft(ctx.activeCompanyId!, ctx.user.id, id, kind, input));
}));

ledgerSourceAuthorityRouter.put('/ledger-source-authority/:id/supplements/:versionId', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(SUPPLEMENT_MANAGE), supplementRoute(async (req, res, { id, versionId }) => {
  const ctx = getAuthenticatedContext(req)!;
  const service = new CutoverSupplementService(pool!);
  const kind = await service.kindOf(ctx.activeCompanyId!, id, versionId!);
  const expected = expectedVersion(req.body);
  if (req.body?.['confirm'] !== true) { res.status(400).json({ error: 'Explicit confirmation is required', code: 'CONFIRMATION_REQUIRED' }); return; }
  const input = parseSupplementInput(kind, req.body);
  if (!input || expected === null) { res.status(400).json({ error: 'Invalid request', code: 'SUPPLEMENT_LINES_INVALID' }); return; }
  res.json(await service.replaceDraft(ctx.activeCompanyId!, ctx.user.id, id, versionId!, expected, input));
}));

ledgerSourceAuthorityRouter.post('/ledger-source-authority/:id/supplements/:versionId/void', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(SUPPLEMENT_MANAGE), supplementRoute(async (req, res, { id, versionId }) => {
  if (!onlyKeys(req.body, ['reason', 'confirm', 'expected_row_version']) || req.body['confirm'] !== true) { res.status(400).json({ error: 'Explicit confirmation is required', code: 'CONFIRMATION_REQUIRED' }); return; }
  const expected = expectedVersion(req.body), reason = typeof req.body['reason'] === 'string' ? req.body['reason'].trim() : '';
  if (expected === null || reason.length < 1 || reason.length > 500) { res.status(400).json({ error: 'Invalid request', code: 'SUPPLEMENT_LINES_INVALID' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  res.json(await new CutoverSupplementService(pool!).voidDraft(ctx.activeCompanyId!, ctx.user.id, id, versionId!, expected, reason));
}));

ledgerSourceAuthorityRouter.post('/ledger-source-authority/:id/supplements/:versionId/approve', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(SUPPLEMENT_APPROVE), supplementRoute(async (req, res, { id, versionId }) => {
  if (!onlyKeys(req.body, ['confirm', 'expected_row_version']) || req.body['confirm'] !== true) { res.status(400).json({ error: 'Explicit confirmation is required', code: 'CONFIRMATION_REQUIRED' }); return; }
  const expected = expectedVersion(req.body);
  if (expected === null) { res.status(400).json({ error: 'Invalid request', code: 'SUPPLEMENT_LINES_INVALID' }); return; }
  const ctx = getAuthenticatedContext(req)!;
  res.json(await new CutoverSupplementService(pool!).approve(ctx.activeCompanyId!, ctx.user.id, id, versionId!, expected));
}));
