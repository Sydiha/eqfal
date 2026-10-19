import express, { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { LedgerCutoverService, parseCutoverInput } from '../accounting/ledger-cutover';
import { LedgerSourceAuthorityError, LedgerSourceAuthorityNotFoundError, LedgerSourceAuthorityService } from '../accounting/ledger-source-authority';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { decodeUploadFilename, detectUploadFormat, readRawSheet } from '../banking/bank.router';
import { parseTrialBalanceTable, TbMapping, TB_MAX_LINES } from '../accounting/cutover-file-import';

// C1B-2: read plus DRAFT create/void. A draft has no accounting effect.
// C1B-3b: preview and activate (the ONLY path to an active range): the cut-over trial balance becomes one posted `cutover_balance` journal and
// the range turns active in the same transaction. Requires the independent critical capability source_authority.activate (no role holds it by default).
export const ledgerSourceAuthorityRouter = Router();
const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next: NextFunction) => {
  void handler(req, res).catch((error) => {
    if (error instanceof LedgerSourceAuthorityNotFoundError) { res.status(404).json({ error: 'Not found' }); return; }
    if (error instanceof LedgerSourceAuthorityError) {
      res.status(error.code === 'AUTHORITY_RANGE_INVALID' || error.code === 'CUTOVER_LINES_INVALID' ? 400 : 409).json({ error: error.message, code: error.code, ...('detail' in error && (error as { detail?: unknown }).detail !== undefined ? { detail: (error as { detail?: unknown }).detail } : {}) });
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

// I1: read-only trial balance file parser for the cut-over form. Writes nothing; the result only fills the form, which still goes through preview/activate.
const tbUpload = express.raw({ type: () => true, limit: 2 * 1024 * 1024 });
const parseTbMapping = (v: unknown): TbMapping | null | undefined => {
  if (v === undefined) return undefined;
  try {
    const x = JSON.parse(decodeURIComponent(String(v))) as Record<string, unknown>;
    const keys = ['header_row', 'code', 'name', 'debit', 'credit', 'balance', 'currency'];
    if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some((k) => !keys.includes(k))) return null;
    for (const k of keys) if (x[k] !== undefined && !(Number.isInteger(x[k]) && (x[k] as number) >= (k === 'header_row' ? 1 : 0) && (x[k] as number) <= 1000)) return null;
    if (x['header_row'] === undefined || x['code'] === undefined) return null;
    return x as unknown as TbMapping;
  } catch { return null; }
};

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
  if (result.status === 'parsed' && sheet.sheetCount > 1) result.warnings.push({ code: 'TB_FIRST_SHEET_ONLY' });
  res.json({ ...result, functional_currency: cur.length === 1 ? cur[0]!.functional_currency : null, cutover_date: range.to_date });
}));
