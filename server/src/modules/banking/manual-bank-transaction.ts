import crypto from 'crypto';
import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool, PoolClient } from 'pg';
import pool from '../../db/pool';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { AccountingPeriodClosedError, assertAccountingDateWritable } from '../monthly-close/accounting-period.guard';

/**
 * Manual bank transactions. A manual row is an internal record (source_kind='manual'), never a bank-verified statement row.
 * It posts no journal. It resolves for closing only through the existing ledger-bearing relationships, like an imported row.
 */
/** Categories an existing workflow can actually resolve (settlement of documents/obligations, or partner/custody/personal-payment links for `other`). */
export const MANUAL_CATEGORIES = ['customer_receipt', 'supplier_payment', 'government_payment', 'other'] as const;
export type ManualCategory = (typeof MANUAL_CATEGORIES)[number];
/** Deferred: needs a designed paired-account workflow so both legs are never counted twice. */
export const DEFERRED_CATEGORIES = ['inter_account_transfer'] as const;
/** Known but disabled until a supported accounting-resolution workflow exists. They would otherwise stay unresolved and block closing. */
export const UNSUPPORTED_CATEGORIES = ['cash_deposit', 'cash_withdrawal', 'incoming_transfer', 'outgoing_transfer', 'bank_fees', 'refund'] as const;
const INCOMING_ONLY: readonly string[] = ['customer_receipt'];
const OUTGOING_ONLY: readonly string[] = ['supplier_payment', 'government_payment'];
/** Kept as a second line of defence for rows that might exist (trigger bank_manual_internal_guard, migration 106). */
export const NON_SETTLEABLE_MANUAL_CATEGORIES: readonly string[] = [...UNSUPPORTED_CATEGORIES.filter((c) => c !== 'refund')];

export function assertManualCategorySettleable(tx: { source_kind?: string; manual_category?: string | null }, ErrorClass: new (m: string) => Error): void {
  if (tx.source_kind === 'manual' && tx.manual_category && NON_SETTLEABLE_MANUAL_CATEGORIES.includes(tx.manual_category)) {
    throw new ErrorClass('Manual cash, transfer and bank-fee transactions cannot settle documents or obligations');
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMOUNT_RE = /^\d{1,13}(?:\.\d{1,2})?$/;
const amountCents = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')); };
const normalizeAmount = (value: string) => { const [whole, fraction = ''] = value.split('.'); return `${whole}.${fraction.padEnd(2, '0')}`; };
const KEYS = ['bank_account_id', 'transaction_date', 'direction', 'category', 'amount', 'description', 'reference', 'counterparty', 'supporting_document_id', 'confirm_duplicate'];

export class ManualBankError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}
type Input = { accountId: string; date: string; direction: 'incoming' | 'outgoing'; category: string; amount: string; description: string; reference: string | null; counterparty: string | null; documentId: string | null; confirmDuplicate: boolean };

function optText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? null : t.length > max ? undefined : t;
}
export function parseManualBody(body: unknown): Input | ManualBankError {
  const bad = (m: string) => new ManualBankError(400, 'MANUAL_BANK_INVALID', m);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Invalid manual bank transaction');
  const x = body as Record<string, unknown>;
  if (Object.keys(x).some((k) => !KEYS.includes(k))) return bad('Invalid manual bank transaction');
  if (typeof x.bank_account_id !== 'string' || !UUID_RE.test(x.bank_account_id)) return bad('Invalid bank account');
  const date = x.transaction_date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return bad('Invalid transaction date');
  if (x.direction !== 'incoming' && x.direction !== 'outgoing') return bad('Invalid direction');
  if (typeof x.category !== 'string') return bad('Invalid category');
  const amount = typeof x.amount === 'number' ? String(x.amount) : x.amount;
  if (typeof amount !== 'string' || !AMOUNT_RE.test(amount) || amountCents(amount) <= 0n) return bad('Amount must be a positive number with at most two decimals');
  const description = optText(x.description, 500);
  if (!description) return bad('Description is required');
  const reference = optText(x.reference, 100); const counterparty = optText(x.counterparty, 200);
  if (reference === undefined || counterparty === undefined) return bad('Invalid reference or counterparty');
  let documentId: string | null = null;
  if (x.supporting_document_id !== undefined && x.supporting_document_id !== null) {
    if (typeof x.supporting_document_id !== 'string' || !UUID_RE.test(x.supporting_document_id)) return bad('Invalid supporting document');
    documentId = x.supporting_document_id;
  }
  if (x.confirm_duplicate !== undefined && typeof x.confirm_duplicate !== 'boolean') return bad('Invalid duplicate confirmation');
  return { accountId: x.bank_account_id, date, direction: x.direction, category: x.category, amount, description, reference, counterparty, documentId, confirmDuplicate: x.confirm_duplicate === true };
}

const sha = (parts: Array<string | null>) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export class ManualBankTransactionService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  async create(companyId: string, actor: string, input: Input) {
    if ((DEFERRED_CATEGORIES as readonly string[]).includes(input.category)) throw new ManualBankError(422, 'PAIRED_TRANSFER_DEFERRED', 'Transfers between company accounts are not supported yet');
    if ((UNSUPPORTED_CATEGORIES as readonly string[]).includes(input.category)) throw new ManualBankError(422, 'MANUAL_CATEGORY_UNSUPPORTED', 'This category has no supported accounting-resolution workflow yet');
    if (!(MANUAL_CATEGORIES as readonly string[]).includes(input.category)) throw new ManualBankError(400, 'MANUAL_BANK_INVALID', 'Invalid category');
    if ((input.direction === 'outgoing' && INCOMING_ONLY.includes(input.category)) || (input.direction === 'incoming' && OUTGOING_ONLY.includes(input.category))) {
      throw new ManualBankError(400, 'DIRECTION_CATEGORY_MISMATCH', 'Direction is not compatible with the category');
    }
    const signed = (input.direction === 'outgoing' ? '-' : '') + normalizeAmount(input.amount);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const account = (await client.query<{ id: string; currency_code: string; is_active: boolean }>('SELECT id,currency_code,is_active FROM bank_accounts WHERE id=$1 AND company_id=$2', [input.accountId, companyId])).rows[0];
      if (!account) throw new ManualBankError(404, 'BANK_ACCOUNT_NOT_FOUND', 'Bank account not found');
      if (!account.is_active) throw new ManualBankError(409, 'BANK_ACCOUNT_INACTIVE', 'Bank account is inactive');
      if (input.documentId) {
        const doc = await client.query('SELECT 1 FROM documents WHERE id=$1 AND company_id=$2', [input.documentId, companyId]);
        if (!doc.rowCount) throw new ManualBankError(404, 'DOCUMENT_NOT_FOUND', 'Supporting document not found');
      }
      await assertAccountingDateWritable(companyId, input.date, client);
      const strong = Boolean(input.reference);
      const fingerprint = strong ? sha(['manual', account.id, input.date, signed, input.reference!.toLowerCase()]) : sha(['manual', account.id, input.date, signed, input.category, input.description.toLowerCase()]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`manual-bank:${companyId}:${account.id}:${input.date}:${signed}`]);
      const hard = await client.query('SELECT id FROM bank_transactions WHERE company_id=$1 AND bank_account_id=$2 AND fingerprint=$3 AND source_kind=\'manual\'', [companyId, account.id, fingerprint]);
      if (strong && hard.rowCount) throw new ManualBankError(409, 'MANUAL_BANK_DUPLICATE', 'A manual transaction with the same reference already exists', { existing_id: hard.rows[0].id });
      // Same account, date and signed amount from any source (manual or imported): surfaced for review, entered only on explicit confirmation.
      const similar = await client.query<{ id: string; source_kind: string }>('SELECT id,source_kind FROM bank_transactions WHERE company_id=$1 AND bank_account_id=$2 AND transaction_date=$3::date AND amount=$4::numeric ORDER BY created_at LIMIT 10', [companyId, account.id, input.date, signed]);
      if (similar.rowCount && !input.confirmDuplicate) {
        throw new ManualBankError(409, 'MANUAL_BANK_POSSIBLE_DUPLICATE', 'A similar bank transaction already exists; confirm to add anyway', { candidates: similar.rows });
      }
      const row = (await client.query<{ id: string }>(
        `INSERT INTO bank_transactions(company_id,bank_account_id,transaction_date,amount,currency_code,description,bank_reference,fingerprint,fingerprint_strength,source_kind,manual_category,manual_counterparty,supporting_document_id,created_by_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10,$11,$12,$13) RETURNING *`,
        [companyId, account.id, input.date, signed, account.currency_code, input.description, input.reference, fingerprint, strong ? 'strong' : 'weak', input.category, input.counterparty, input.documentId, actor])).rows[0] as Record<string, unknown>;
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'bank_transaction.manual_create', entity_type: 'bank_transaction', entity_id: row.id as string, before_data: null,
        after_data: { source: 'manual', bank_account_id: account.id, transaction_date: input.date, direction: input.direction, category: input.category, amount: signed, reference: input.reference, counterparty: input.counterparty, supporting_document_id: input.documentId, duplicate_confirmed: Boolean(similar.rowCount) },
      }, client);
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AccountingPeriodClosedError) throw new ManualBankError(409, error.code, error.message);
      if ((error as { code?: string }).code === '23505') throw new ManualBankError(409, 'MANUAL_BANK_DUPLICATE', 'A manual transaction with the same reference already exists');
      throw error;
    } finally { client.release(); }
  }
}

export const manualBankTransactionRouter = Router();
const asyncRoute = (h: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler => (req, res, next) => void h(req, res, next).catch(next);
manualBankTransactionRouter.post('/bank-transactions/manual', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability('bank.transaction.manual'), asyncRoute(async (req, res) => {
  const context = getAuthenticatedContext(req);
  if (!context?.activeCompanyId) { res.status(403).json({ error: 'No active company', code: 'NO_ACTIVE_COMPANY' }); return; }
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  const input = parseManualBody(req.body);
  try {
    if (input instanceof ManualBankError) throw input;
    const transaction = await new ManualBankTransactionService(pool).create(context.activeCompanyId, context.user.id, input);
    res.status(201).json({ transaction });
  } catch (error) {
    if (error instanceof ManualBankError) { res.status(error.status).json({ error: error.message, code: error.code, ...error.extra }); return; }
    throw error;
  }
}));
