import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { BankStatementError, BankStatementService, StatementInput, validDate } from './bank-statement.service';

export const bankStatementRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BALANCE = /^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const STATUSES = ['draft', 'confirmed', 'superseded'];
const MODES = ['off', 'warn', 'enforce'];
const asyncRoute = (h: (q: Request, s: Response, n: NextFunction) => Promise<void>): RequestHandler => (q, s, n) => void h(q, s, n).catch(n);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every(k => keys.includes(k));
const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const bad = (message = 'Invalid bank statement request') => new BankStatementError(400, 'BANK_STATEMENT_INVALID', message);

const ctx = (req: Request) => getAuthenticatedContext(req)! as NonNullable<ReturnType<typeof getAuthenticatedContext>> & { activeCompanyId: string };

function handle(error: unknown, res: Response): boolean {
  if (error instanceof BankStatementError) { res.status(error.status).json({ error: error.message, code: error.code }); return true; }
  if (error instanceof AccountingPeriodClosedError) { res.status(409).json({ error: error.message, code: error.code }); return true; }
  return false;
}
const run = (fn: (s: BankStatementService, q: Request, r: Response) => Promise<void>): RequestHandler => asyncRoute(async (q, r) => {
  if (!pool) { r.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  try { await fn(new BankStatementService(pool), q, r); } catch (e) { if (!handle(e, r)) throw e; }
});

function balance(v: unknown): string {
  const text = typeof v === 'number' ? String(v) : v;
  if (typeof text !== 'string' || !BALANCE.test(text)) throw bad('Balances must be decimal amounts with at most two decimals');
  return Number(text) === 0 ? '0.00' : text;
}
function optionalText(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw bad();
  const t = v.trim();
  if (t.length > max) throw bad();
  return t || null;
}
const STATEMENT_KEYS = ['bank_account_id', 'statement_ref', 'period_start', 'period_end', 'opening_balance', 'closing_balance', 'import_batch_id', 'note'];
function parseStatement(body: Record<string, unknown>): StatementInput {
  const bankAccountId = uuid(body['bank_account_id']);
  const ref = typeof body['statement_ref'] === 'string' ? body['statement_ref'].trim() : '';
  if (!bankAccountId || !ref || ref.length > 100 || !validDate(body['period_start']) || !validDate(body['period_end'])) throw bad();
  const batch = body['import_batch_id'];
  const batchId = batch === null || batch === undefined || batch === '' ? null : uuid(batch);
  if (batch !== null && batch !== undefined && batch !== '' && !batchId) throw bad();
  return {
    bankAccountId, statementRef: ref, periodStart: body['period_start'], periodEnd: body['period_end'],
    openingBalance: body['opening_balance'] === null || body['opening_balance'] === undefined || body['opening_balance'] === '' ? null : balance(body['opening_balance']),
    closingBalance: balance(body['closing_balance']), importBatchId: batchId, note: optionalText(body['note'], 500),
  };
}
const version = (v: unknown): number => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw bad('A statement version is required'); return v; };
const idParam = (q: Request): string => { const id = uuid(q.params['id']); if (!id) throw new BankStatementError(404, 'BANK_STATEMENT_NOT_FOUND', 'Not found'); return id; };

const read = [requireAuth, requireActiveCompany, requireCapability('bank.view')];
const write = [requireSameOrigin, requireAuth, requireActiveCompany];

/* ---- settings ---- */
bankStatementRouter.get('/bank-reconciliation/settings', ...read, run(async (s, q, r) => { r.json(await s.getSettings(ctx(q).activeCompanyId)); }));
bankStatementRouter.put('/bank-reconciliation/settings', ...write, requireCapability('bank.reconciliation.settings'), run(async (s, q, r) => {
  const b = q.body;
  if (!plain(b) || !only(b, ['mode', 'enforce_from', 'version'])) throw bad();
  const mode = b['mode'];
  const from = b['enforce_from'] ?? null;
  const v = b['version'];
  if (typeof mode !== 'string' || !MODES.includes(mode) || (from !== null && !validDate(from)) || typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw bad();
  r.json(await s.updateSettings(ctx(q).activeCompanyId, ctx(q).user.id, { mode: mode as 'off' | 'warn' | 'enforce', enforceFrom: from, version: v }));
}));

/* ---- ledger links (bank account management authority) ---- */
bankStatementRouter.get('/bank-ledger-links', ...read, run(async (s, q, r) => { r.json(await s.listLinks(ctx(q).activeCompanyId)); }));
bankStatementRouter.post('/bank-ledger-links', ...write, requireCapability('bank.account.manage'), run(async (s, q, r) => {
  const b = q.body;
  if (!plain(b) || !only(b, ['bank_account_id', 'account_id', 'valid_from'])) throw bad();
  const bankAccountId = uuid(b['bank_account_id']);
  const accountId = uuid(b['account_id']);
  if (!bankAccountId || !accountId || !validDate(b['valid_from'])) throw bad();
  r.status(201).json(await s.createLink(ctx(q).activeCompanyId, ctx(q).user.id, { bankAccountId, accountId, validFrom: b['valid_from'] }));
}));
bankStatementRouter.post('/bank-ledger-links/:id/end', ...write, requireCapability('bank.account.manage'), run(async (s, q, r) => {
  const b = q.body;
  if (!plain(b) || !only(b, ['valid_to']) || !validDate(b['valid_to'])) throw bad();
  r.json(await s.endLink(ctx(q).activeCompanyId, ctx(q).user.id, idParam(q), b['valid_to']));
}));

/* ---- statements ---- */
bankStatementRouter.get('/bank-statements', ...read, run(async (s, q, r) => {
  const bankAccountId = q.query['bank_account_id'] === undefined ? undefined : uuid(q.query['bank_account_id']);
  const status = q.query['status'];
  if (bankAccountId === null || (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status)))) throw bad();
  r.json(await s.listStatements(ctx(q).activeCompanyId, { bankAccountId, status: status as string | undefined }));
}));
bankStatementRouter.post('/bank-statements', ...write, requireCapability('bank.statement.manage'), run(async (s, q, r) => {
  if (!plain(q.body) || !only(q.body, STATEMENT_KEYS)) throw bad();
  r.status(201).json(await s.createDraft(ctx(q).activeCompanyId, ctx(q).user.id, parseStatement(q.body)));
}));
bankStatementRouter.patch('/bank-statements/:id', ...write, requireCapability('bank.statement.manage'), run(async (s, q, r) => {
  const id = idParam(q);
  if (!plain(q.body) || !only(q.body, [...STATEMENT_KEYS, 'version'])) throw bad();
  r.json(await s.updateDraft(ctx(q).activeCompanyId, ctx(q).user.id, id, version(q.body['version']), parseStatement(q.body)));
}));
bankStatementRouter.delete('/bank-statements/:id', ...write, requireCapability('bank.statement.manage'), run(async (s, q, r) => {
  const id = idParam(q);
  await s.deleteDraft(ctx(q).activeCompanyId, ctx(q).user.id, id, version(Number(q.query['version'])));
  r.status(204).end();
}));
bankStatementRouter.post('/bank-statements/:id/confirm', ...write, requireCapability('bank.statement.confirm'), run(async (s, q, r) => {
  const id = idParam(q);
  if (!plain(q.body) || !only(q.body, ['version'])) throw bad();
  r.json(await s.confirm(ctx(q).activeCompanyId, ctx(q).user.id, id, version(q.body['version'])));
}));
bankStatementRouter.post('/bank-statements/:id/supersede', ...write, requireCapability('bank.statement.confirm'), run(async (s, q, r) => {
  const id = idParam(q);
  if (!plain(q.body) || !only(q.body, [...STATEMENT_KEYS, 'version', 'reason'])) throw bad();
  const reason = typeof q.body['reason'] === 'string' ? q.body['reason'] : '';
  r.status(201).json(await s.supersede(ctx(q).activeCompanyId, ctx(q).user.id, id, version(q.body['version']), reason, parseStatement(q.body)));
}));

/* ---- calculation views ---- */
bankStatementRouter.get('/bank-reconciliation/preview', ...read, run(async (s, q, r) => {
  const bankAccountId = uuid(q.query['bank_account_id']);
  const periodEnd = q.query['period_end'];
  if (!bankAccountId || !validDate(periodEnd)) throw bad('bank_account_id and period_end are required');
  r.json(await s.preview(ctx(q).activeCompanyId, bankAccountId, periodEnd));
}));
bankStatementRouter.get('/bank-reconciliation/status', ...read, run(async (s, q, r) => {
  const from = q.query['period_start'];
  const to = q.query['period_end'];
  if (!validDate(from) || !validDate(to) || to < from) throw bad('A valid period_start/period_end range is required');
  r.json(await s.status(ctx(q).activeCompanyId, from, to));
}));
