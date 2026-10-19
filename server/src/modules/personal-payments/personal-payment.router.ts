import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { FiscalYearClosedError, JournalPostingConflictError, JournalPostingNotFoundError, JournalPostingValidationError, LedgerSourceAuthorityBlockedError } from '../accounting/journal-posting';
import { AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { PaymentInput, PayerInput, PersonalPaymentError, PersonalPaymentService, Treatment, validDate } from './personal-payment.service';

export const personalPaymentRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const STATUSES = ['draft', 'submitted', 'approved', 'rejected'];
const asyncRoute = (h: (q: Request, s: Response, n: NextFunction) => Promise<void>): RequestHandler => (q, s, n) => void h(q, s, n).catch(n);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const bad = (message = 'Invalid personal payment request') => new PersonalPaymentError(400, 'PERSONAL_PAYMENT_INVALID', message);
const missing = () => new PersonalPaymentError(404, 'PERSONAL_PAYMENT_NOT_FOUND', 'Not found');

function ctx(req: Request) {
  return getAuthenticatedContext(req)! as NonNullable<ReturnType<typeof getAuthenticatedContext>> & { activeCompanyId: string };
}
function service(res: Response): PersonalPaymentService | null {
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return null; }
  return new PersonalPaymentService(pool);
}
function handle(error: unknown, res: Response): boolean {
  if (error instanceof PersonalPaymentError) { res.status(error.status).json({ error: error.message, code: error.code }); return true; }
  if (error instanceof JournalPostingValidationError) { res.status(400).json({ error: error.message, code: 'PERSONAL_PAYMENT_JOURNAL_INVALID' }); return true; }
  if (error instanceof JournalPostingNotFoundError) { res.status(404).json({ error: 'Not found', code: 'PERSONAL_PAYMENT_NOT_FOUND' }); return true; }
  if (error instanceof LedgerSourceAuthorityBlockedError) { res.status(409).json({ error: error.message, code: error.code }); return true; }
  if (error instanceof FiscalYearClosedError) { res.status(409).json({ error: error.message, code: 'PERSONAL_PAYMENT_FISCAL_YEAR_CLOSED' }); return true; }
  if (error instanceof AccountingPeriodClosedError) { res.status(409).json({ error: error.message, code: 'PERSONAL_PAYMENT_PERIOD_CLOSED' }); return true; }
  if (error instanceof JournalPostingConflictError) { res.status(409).json({ error: error.message, code: 'PERSONAL_PAYMENT_JOURNAL_CONFLICT' }); return true; }
  return false;
}
const run = (fn: (s: PersonalPaymentService, q: Request, r: Response) => Promise<void>): RequestHandler => asyncRoute(async (q, r) => {
  const s = service(r);
  if (!s) return;
  try { await fn(s, q, r); } catch (e) { if (!handle(e, r)) throw e; }
});

function text(v: unknown, min: number, max: number): string {
  if (typeof v !== 'string') throw bad();
  const t = v.trim();
  if (t.length < min || t.length > max) throw bad();
  return t;
}
const optionalUuid = (v: unknown): string | null => { if (v === null || v === undefined || v === '') return null; const id = uuid(v); if (!id) throw bad(); return id; };
const version = (v: unknown): number => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw bad(); return v; };
const emptyBody = (b: unknown) => b === undefined || (plain(b) && Object.keys(b).length === 0);
const idParam = (q: Request): string => { const id = uuid(q.params['id']); if (!id) throw missing(); return id; };

function parsePayment(body: unknown): PaymentInput {
  if (!plain(body) || !only(body, ['payer_id', 'treatment', 'payment_date', 'amount', 'purpose', 'counterparty_id', 'document_id', 'obligation_id', 'expense_account_id', 'version'])) throw bad();
  const payerId = uuid(body['payer_id']);
  const treatment = body['treatment'];
  const amount = typeof body['amount'] === 'number' ? String(body['amount']) : body['amount'];
  if (!payerId || (treatment !== 'new_expense' && treatment !== 'existing_obligation') || !validDate(body['payment_date']) || typeof amount !== 'string' || !MONEY.test(amount) || Number(amount) <= 0) throw bad();
  return {
    payerId, treatment: treatment as Treatment, paymentDate: body['payment_date'], amount: Number(amount).toFixed(2), purpose: text(body['purpose'], 1, 500),
    counterpartyId: optionalUuid(body['counterparty_id']), documentId: optionalUuid(body['document_id']), obligationId: optionalUuid(body['obligation_id']),
    expenseAccountId: optionalUuid(body['expense_account_id']),
  };
}

const read = [requireAuth, requireActiveCompany, requireCapability('personal_payment.view')];
const write = [requireSameOrigin, requireAuth, requireActiveCompany];

// ---- payers
personalPaymentRouter.get('/personal-payments/payers', ...read, run(async (s, q, r) => {
  r.json(await s.payers(ctx(q).activeCompanyId, ctx(q).capabilities.includes('personal_payment.payer.manage')));
}));
personalPaymentRouter.post('/personal-payments/payers', ...write, requireCapability('personal_payment.payer.manage'), run(async (s, q, r) => {
  const b = q.body;
  if (!plain(b) || !only(b, ['display_name', 'user_id', 'partner_id', 'payable_account_id'])) throw bad();
  const input: PayerInput = { displayName: text(b['display_name'], 1, 200), userId: optionalUuid(b['user_id']), partnerId: optionalUuid(b['partner_id']), payableAccountId: optionalUuid(b['payable_account_id']) };
  r.status(201).json(await s.createPayer(ctx(q).activeCompanyId, ctx(q).user.id, input));
}));
personalPaymentRouter.patch('/personal-payments/payers/:id', ...write, requireCapability('personal_payment.payer.manage'), run(async (s, q, r) => {
  const id = idParam(q);
  const b = q.body;
  if (!plain(b) || !only(b, ['display_name', 'is_active', 'payable_account_id', 'version'])) throw bad();
  const patch: { displayName?: string; isActive?: boolean; payableAccountId?: string | null } = {};
  if ('display_name' in b) patch.displayName = text(b['display_name'], 1, 200);
  if ('is_active' in b) { if (typeof b['is_active'] !== 'boolean') throw bad(); patch.isActive = b['is_active']; }
  if ('payable_account_id' in b) patch.payableAccountId = optionalUuid(b['payable_account_id']);
  r.json(await s.updatePayer(ctx(q).activeCompanyId, ctx(q).user.id, id, patch, version(b['version'])));
}));

// ---- lookups and reporting
personalPaymentRouter.get('/personal-payments/lookups', ...read, run(async (s, q, r) => {
  r.json(await s.lookups(ctx(q).activeCompanyId, ctx(q).capabilities.includes('personal_payment.create')));
}));
personalPaymentRouter.get('/personal-payments/payables', ...read, run(async (s, q, r) => {
  const asOf = q.query['as_of'];
  if (!validDate(asOf)) throw bad('as_of must be a valid date');
  r.json(await s.payables(ctx(q).activeCompanyId, asOf));
}));

// ---- payments
personalPaymentRouter.get('/personal-payments', ...read, run(async (s, q, r) => {
  const payerId = q.query['payer_id'] === undefined ? undefined : uuid(q.query['payer_id']);
  const status = q.query['status'];
  const from = q.query['from'];
  const to = q.query['to'];
  if (payerId === null || (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) || (from !== undefined && !validDate(from)) || (to !== undefined && !validDate(to))) throw bad();
  const limit = q.query['limit'] === undefined ? 200 : Number(q.query['limit']);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw bad();
  r.json(await s.list(ctx(q).activeCompanyId, { payerId, status: status as string | undefined, from: from as string | undefined, to: to as string | undefined, limit }));
}));

personalPaymentRouter.get('/personal-payments/:id/review', ...read, run(async (s, q, r) => {
  const caps = ctx(q).capabilities;
  const audit = caps.includes('personal_payment.audit.view');
  const reviewer = caps.includes('personal_payment.review');
  r.json(await s.review(ctx(q).activeCompanyId, ctx(q).user.id, idParam(q), { includeAccounts: reviewer || audit, includeHistory: reviewer || audit, includeJournalLinks: audit }));
}));

personalPaymentRouter.get('/personal-payments/:id', ...read, run(async (s, q, r) => {
  r.json(await s.get(ctx(q).activeCompanyId, idParam(q), ctx(q).capabilities.includes('personal_payment.audit.view')));
}));

personalPaymentRouter.post('/personal-payments', ...write, requireCapability('personal_payment.create'), run(async (s, q, r) => {
  const input = parsePayment(q.body);
  if ('version' in (q.body as Record<string, unknown>)) throw bad();
  r.status(201).json({ payment: await s.create(ctx(q).activeCompanyId, ctx(q).user.id, input) });
}));

personalPaymentRouter.patch('/personal-payments/:id', ...write, requireCapability('personal_payment.create'), run(async (s, q, r) => {
  const id = idParam(q);
  const v = version((q.body as Record<string, unknown> | undefined)?.['version']);
  r.json({ payment: await s.update(ctx(q).activeCompanyId, ctx(q).user.id, id, parsePayment(q.body), v) });
}));

personalPaymentRouter.delete('/personal-payments/:id', ...write, requireCapability('personal_payment.create'), run(async (s, q, r) => {
  const id = idParam(q);
  const v = Number(q.query['version']);
  if (!Number.isInteger(v) || v < 1) throw bad();
  await s.remove(ctx(q).activeCompanyId, ctx(q).user.id, id, v);
  r.status(204).end();
}));

personalPaymentRouter.post('/personal-payments/:id/submit', ...write, requireCapability('personal_payment.submit'), run(async (s, q, r) => {
  const id = idParam(q);
  if (!emptyBody(q.body)) throw bad();
  r.json(await s.submit(ctx(q).activeCompanyId, ctx(q).user.id, id));
}));

personalPaymentRouter.post('/personal-payments/:id/approve', ...write, requireCapability('personal_payment.review'), run(async (s, q, r) => {
  const id = idParam(q);
  const b = q.body;
  if (!plain(b) || !only(b, ['confirm_review', 'version'])) throw bad();
  if (b['confirm_review'] !== true) throw new PersonalPaymentError(400, 'PERSONAL_PAYMENT_REVIEW_CONFIRMATION_REQUIRED', 'Approval requires explicit confirmation that the payment was reviewed');
  r.json(await s.approve(ctx(q).activeCompanyId, ctx(q).user.id, id, version(b['version']), ctx(q).capabilities.includes('personal_payment.audit.view')));
}));

personalPaymentRouter.post('/personal-payments/:id/reject', ...write, requireCapability('personal_payment.review'), run(async (s, q, r) => {
  const id = idParam(q);
  const b = q.body;
  if (!plain(b) || !only(b, ['reason'])) throw bad();
  r.json({ payment: await s.reject(ctx(q).activeCompanyId, ctx(q).user.id, id, text(b['reason'], 1, 500)) });
}));

personalPaymentRouter.post('/personal-payments/:id/reopen', ...write, requireCapability('personal_payment.create'), run(async (s, q, r) => {
  const id = idParam(q);
  if (!emptyBody(q.body)) throw bad();
  r.json({ payment: await s.reopen(ctx(q).activeCompanyId, ctx(q).user.id, id) });
}));

personalPaymentRouter.get('/personal-payments/:id/reimbursable-bank-transactions', requireAuth, requireActiveCompany, requireCapability('personal_payment.reimburse'), run(async (s, q, r) => {
  r.json(await s.reimbursableBankTransactions(ctx(q).activeCompanyId, idParam(q)));
}));

personalPaymentRouter.post('/personal-payments/:id/reimbursements', ...write, requireCapability('personal_payment.reimburse'), run(async (s, q, r) => {
  const id = idParam(q);
  const b = q.body;
  if (!plain(b) || !only(b, ['bank_transaction_id', 'note'])) throw bad();
  const bankTransactionId = uuid(b['bank_transaction_id']);
  if (!bankTransactionId) throw bad();
  const note = b['note'] === undefined || b['note'] === null || b['note'] === '' ? null : text(b['note'], 1, 500);
  const result = await s.reimburse(ctx(q).activeCompanyId, ctx(q).user.id, id, { bankTransactionId, note }, ctx(q).capabilities.includes('personal_payment.audit.view'));
  r.status(result.replayed ? 200 : 201).json(result);
}));
