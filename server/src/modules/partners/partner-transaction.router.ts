import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { FiscalYearClosedError, JournalPostingConflictError, JournalPostingNotFoundError, JournalPostingValidationError, LedgerSourceAuthorityBlockedError } from '../accounting/journal-posting';
import { AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { isPartnerTransactionType } from '../accounting/partner-transaction-posting';
import { Channel, PartnerTransactionError, PartnerTransactionInput, PartnerTransactionService, validDate } from './partner-transaction.service';

export const partnerTransactionRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const STATUSES = ['draft', 'posted', 'reversed'];
const asyncRoute = (h: (q: Request, s: Response, n: NextFunction) => Promise<void>): RequestHandler => (q, s, n) => void h(q, s, n).catch(n);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const bad = (message = 'Invalid partner transaction request') => new PartnerTransactionError(400, 'PARTNER_TRANSACTION_INVALID', message);

function ctx(req: Request) {
  return getAuthenticatedContext(req)! as NonNullable<ReturnType<typeof getAuthenticatedContext>> & { activeCompanyId: string };
}
function service(res: Response): PartnerTransactionService | null {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return null; }
  return new PartnerTransactionService(pool);
}
function handle(error: unknown, res: Response): boolean {
  if (error instanceof PartnerTransactionError) { res.status(error.status).json({ error: error.message, code: error.code }); return true; }
  if (error instanceof JournalPostingValidationError) { res.status(400).json({ error: error.message, code: 'PARTNER_JOURNAL_INVALID' }); return true; }
  if (error instanceof JournalPostingNotFoundError) { res.status(404).json({ error: 'Not found', code: 'PARTNER_TRANSACTION_NOT_FOUND' }); return true; }
  if (error instanceof LedgerSourceAuthorityBlockedError) { res.status(409).json({ error: error.message, code: error.code }); return true; }
  if (error instanceof FiscalYearClosedError) { res.status(409).json({ error: error.message, code: 'PARTNER_FISCAL_YEAR_CLOSED' }); return true; }
  if (error instanceof AccountingPeriodClosedError) { res.status(409).json({ error: error.message, code: 'PARTNER_PERIOD_CLOSED' }); return true; }
  if (error instanceof JournalPostingConflictError) { res.status(409).json({ error: error.message, code: 'PARTNER_JOURNAL_CONFLICT' }); return true; }
  return false;
}
const run = (fn: (s: PartnerTransactionService, q: Request, r: Response) => Promise<void>): RequestHandler => asyncRoute(async (q, r) => {
  const s = service(r);
  if (!s) return;
  try { await fn(s, q, r); } catch (e) { if (!handle(e, r)) throw e; }
});

function nullableText(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw bad();
  const t = v.trim();
  if (!t) return null;
  if (t.length > max) throw bad();
  return t;
}
function parseInput(body: unknown): PartnerTransactionInput {
  if (!plain(body) || !only(body, ['partner_id', 'transaction_type', 'transaction_date', 'amount', 'channel', 'bank_account_id', 'bank_transaction_id', 'document_id', 'reference', 'description', 'version'])) throw bad();
  const partnerId = uuid(body['partner_id']);
  const type = body['transaction_type'];
  const amount = typeof body['amount'] === 'number' ? String(body['amount']) : body['amount'];
  const channel = body['channel'];
  if (!partnerId || !isPartnerTransactionType(type) || !validDate(body['transaction_date']) || typeof amount !== 'string' || !MONEY.test(amount) || Number(amount) <= 0) throw bad();
  if (channel !== 'bank' && channel !== 'cash') throw bad();
  const optionalUuid = (v: unknown) => { if (v === null || v === undefined || v === '') return null; const id = uuid(v); if (!id) throw bad(); return id; };
  return {
    partnerId, type, date: body['transaction_date'], amount: Number(amount).toFixed(2), channel: channel as Channel,
    bankAccountId: optionalUuid(body['bank_account_id']), bankTransactionId: optionalUuid(body['bank_transaction_id']), documentId: optionalUuid(body['document_id']),
    reference: nullableText(body['reference'], 200), description: nullableText(body['description'], 1000),
  };
}
const version = (v: unknown): number => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw bad(); return v; };
const emptyBody = (b: unknown) => b === undefined || (plain(b) && Object.keys(b).length === 0);

const read = [requireAuth, requireActiveCompany, requireCapability('partner.transaction.view')];
const write = [requireSameOrigin, requireAuth, requireActiveCompany];

partnerTransactionRouter.get('/partners/transactions', ...read, run(async (s, q, r) => {
  const partnerId = q.query['partner_id'] === undefined ? undefined : uuid(q.query['partner_id']);
  const status = q.query['status'];
  const from = q.query['from'];
  const to = q.query['to'];
  if (partnerId === null || (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) || (from !== undefined && !validDate(from)) || (to !== undefined && !validDate(to))) throw bad();
  const limit = q.query['limit'] === undefined ? 200 : Number(q.query['limit']);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw bad();
  r.json(await s.list(ctx(q).activeCompanyId, { partnerId, status: status as string | undefined, from: from as string | undefined, to: to as string | undefined, limit }));
}));

partnerTransactionRouter.get('/partners/balances', ...read, run(async (s, q, r) => {
  const asOf = q.query['as_of'];
  if (!validDate(asOf)) throw bad('as_of must be a valid date');
  r.json(await s.balances(ctx(q).activeCompanyId, asOf));
}));

partnerTransactionRouter.get('/partners/account-mappings', ...read, run(async (s, q, r) => { r.json(await s.mappings(ctx(q).activeCompanyId, ctx(q).capabilities.includes('partner.account_mapping.manage'))); }));

partnerTransactionRouter.get('/partners/:id/ledger', ...read, run(async (s, q, r) => {
  const id = uuid(q.params['id']);
  const from = q.query['from'];
  const to = q.query['to'];
  if (!id || !validDate(from) || !validDate(to) || to < from) throw bad('A valid from/to range is required');
  r.json(await s.ledger(ctx(q).activeCompanyId, id, from, to));
}));

partnerTransactionRouter.get('/partners/transactions/:id', ...read, run(async (s, q, r) => {
  const id = uuid(q.params['id']);
  if (!id) throw new PartnerTransactionError(404, 'PARTNER_TRANSACTION_NOT_FOUND', 'Not found');
  r.json(await s.get(ctx(q).activeCompanyId, id));
}));

partnerTransactionRouter.post('/partners/transactions', ...write, requireCapability('partner.transaction.create'), run(async (s, q, r) => {
  const input = parseInput(q.body);
  if ('version' in (q.body as Record<string, unknown>)) throw bad();
  r.status(201).json(await s.create(ctx(q).activeCompanyId, ctx(q).user.id, input));
}));

partnerTransactionRouter.patch('/partners/transactions/:id', ...write, requireCapability('partner.transaction.create'), run(async (s, q, r) => {
  const id = uuid(q.params['id']);
  if (!id) throw new PartnerTransactionError(404, 'PARTNER_TRANSACTION_NOT_FOUND', 'Not found');
  const v = version((q.body as Record<string, unknown> | undefined)?.['version']);
  r.json(await s.update(ctx(q).activeCompanyId, ctx(q).user.id, id, parseInput(q.body), v));
}));

partnerTransactionRouter.delete('/partners/transactions/:id', ...write, requireCapability('partner.transaction.create'), run(async (s, q, r) => {
  const id = uuid(q.params['id']);
  if (!id) throw new PartnerTransactionError(404, 'PARTNER_TRANSACTION_NOT_FOUND', 'Not found');
  const v = Number(q.query['version']);
  if (!Number.isInteger(v) || v < 1) throw bad();
  await s.remove(ctx(q).activeCompanyId, ctx(q).user.id, id, v);
  r.status(204).end();
}));

partnerTransactionRouter.post('/partners/transactions/:id/post', ...write, requireCapability('partner.transaction.post'), run(async (s, q, r) => {
  const id = uuid(q.params['id']);
  if (!id) throw new PartnerTransactionError(404, 'PARTNER_TRANSACTION_NOT_FOUND', 'Not found');
  if (!emptyBody(q.body)) throw bad();
  r.json(await s.post(ctx(q).activeCompanyId, ctx(q).user.id, id));
}));

partnerTransactionRouter.post('/partners/transactions/:id/reverse', ...write, requireCapability('partner.transaction.reverse'), run(async (s, q, r) => {
  const id = uuid(q.params['id']);
  const b = q.body;
  if (!id) throw new PartnerTransactionError(404, 'PARTNER_TRANSACTION_NOT_FOUND', 'Not found');
  if (!plain(b) || !only(b, ['reversal_date', 'reason']) || !validDate(b['reversal_date']) || typeof b['reason'] !== 'string') throw bad();
  const reason = b['reason'].trim();
  if (!reason || reason.length > 500) throw bad('A reversal reason of 1-500 characters is required');
  r.json(await s.reverse(ctx(q).activeCompanyId, ctx(q).user.id, id, { date: b['reversal_date'], reason }));
}));

const manage = requireCapability('partner.account_mapping.manage');
partnerTransactionRouter.put('/partners/:id/account-mappings/:key', ...write, manage, run(async (s, q, r) => {
  const id = uuid(q.params['id']);
  const b = q.body;
  if (!id || !plain(b) || !only(b, ['account_id'])) throw bad();
  const account = uuid(b['account_id']);
  if (!account) throw bad();
  await s.setPartnerMapping(ctx(q).activeCompanyId, ctx(q).user.id, id, q.params['key'], account);
  r.json(await s.mappings(ctx(q).activeCompanyId, true));
}));
partnerTransactionRouter.delete('/partners/:id/account-mappings/:key', ...write, manage, run(async (s, q, r) => {
  const id = uuid(q.params['id']);
  if (!id) throw bad();
  await s.clearPartnerMapping(ctx(q).activeCompanyId, ctx(q).user.id, id, q.params['key']);
  r.json(await s.mappings(ctx(q).activeCompanyId, true));
}));
// bank_account_id 'cash' addresses the company's cash (non-bank) mapping.
const bankTarget = (v: unknown): string | null | undefined => (v === 'cash' ? null : uuid(v) ?? undefined);
partnerTransactionRouter.put('/partners/cash-account-mappings/:target', ...write, manage, run(async (s, q, r) => {
  const target = bankTarget(q.params['target']);
  const b = q.body;
  if (target === undefined || !plain(b) || !only(b, ['account_id'])) throw bad();
  const account = uuid(b['account_id']);
  if (!account) throw bad();
  await s.setCashMapping(ctx(q).activeCompanyId, ctx(q).user.id, target, account);
  r.json(await s.mappings(ctx(q).activeCompanyId, true));
}));
partnerTransactionRouter.delete('/partners/cash-account-mappings/:target', ...write, manage, run(async (s, q, r) => {
  const target = bankTarget(q.params['target']);
  if (target === undefined) throw bad();
  await s.clearCashMapping(ctx(q).activeCompanyId, ctx(q).user.id, target);
  r.json(await s.mappings(ctx(q).activeCompanyId, true));
}));
