import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool, PoolClient } from 'pg';
import pool from '../../db/pool';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { AuthSessionContext } from '../auth/session.service';

export const documentSettlementRouter = Router();

const VIEW = 'bank.view';
const SETTLE = 'payment.settle';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMOUNT_RE = /^\d{1,16}(?:\.\d{1,2})?$/;

type ActiveAuthContext = AuthSessionContext & { activeCompanyId: string };
type DocumentRow = { id: string; company_id: string; status: string; total_amount: string | null; original_filename: string };
type TransactionRow = { id: string; company_id: string };
type MatchRow = { bank_transaction_id: string; company_id: string; document_id: string };
type SettlementRow = {
  id: string;
  company_id: string;
  document_id: string;
  bank_transaction_id: string;
  amount: string;
  created_by_user_id: string;
  created_at: Date;
  note: string | null;
};

type SettlementView = SettlementRow & {
  transaction_date: string;
  transaction_description: string | null;
  bank_reference: string | null;
  transaction_amount: string;
};

export class DocumentSettlementNotFoundError extends Error {}
export class DocumentSettlementConflictError extends Error {}
export class DocumentSettlementValidationError extends Error {}

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => void handler(req, res, next).catch(next);
}

function activeContext(req: Request, res: Response): ActiveAuthContext | null {
  const context = getAuthenticatedContext(req);
  if (!context?.activeCompanyId) {
    res.status(403).json({ error: 'No active company' });
    return null;
  }
  return context as ActiveAuthContext;
}

function serviceOr503(res: Response): DocumentSettlementService | null {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable' });
    return null;
  }
  return new DocumentSettlementService(pool);
}

function parseId(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

function parseCreateBody(body: unknown): { transactionId: string; amount: string; note: string | null } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const x = body as Record<string, unknown>;
  if (Object.keys(x).some((key) => !['bank_transaction_id', 'amount', 'note'].includes(key))) return null;
  const transactionId = parseId(x.bank_transaction_id);
  const amount = typeof x.amount === 'string' ? x.amount.trim() : typeof x.amount === 'number' ? String(x.amount) : '';
  if (!transactionId || !AMOUNT_RE.test(amount) || moneyToCents(amount) <= 0n) return null;
  if (x.note !== undefined && x.note !== null && typeof x.note !== 'string') return null;
  const note = typeof x.note === 'string' ? x.note.trim() || null : null;
  if (note && note.length > 500) return null;
  return { transactionId, amount, note };
}

function parseDeleteBody(body: unknown): { reason: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const x = body as Record<string, unknown>;
  if (Object.keys(x).length !== 1 || typeof x.reason !== 'string') return null;
  const reason = x.reason.trim();
  if (!reason || reason.length > 500) return null;
  return { reason };
}

function moneyToCents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

function centsToMoney(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

class DocumentSettlementRepository {
  constructor(private readonly db: Pool) {}

  async document(id: string, companyId: string, client?: PoolClient, lock = false): Promise<DocumentRow | null> {
    const db = client ?? this.db;
    const { rows } = await db.query<DocumentRow>(
      `SELECT id,company_id,status,total_amount,original_filename FROM documents WHERE id=$1 AND company_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [id, companyId],
    );
    return rows[0] ?? null;
  }

  async transaction(id: string, companyId: string, client: PoolClient, lock = false): Promise<TransactionRow | null> {
    const { rows } = await client.query<TransactionRow>(
      `SELECT id,company_id FROM bank_transactions WHERE id=$1 AND company_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [id, companyId],
    );
    return rows[0] ?? null;
  }

  async match(transactionId: string, documentId: string, companyId: string, client: PoolClient): Promise<MatchRow | null> {
    const { rows } = await client.query<MatchRow>(
      'SELECT bank_transaction_id,company_id,document_id FROM bank_transaction_matches WHERE bank_transaction_id=$1 AND document_id=$2 AND company_id=$3',
      [transactionId, documentId, companyId],
    );
    return rows[0] ?? null;
  }

  async settledTotal(documentId: string, companyId: string, client?: PoolClient): Promise<string> {
    const db = client ?? this.db;
    const { rows } = await db.query<{ total: string }>(
      'SELECT COALESCE(SUM(amount),0)::text AS total FROM document_settlements WHERE document_id=$1 AND company_id=$2',
      [documentId, companyId],
    );
    return rows[0]?.total ?? '0';
  }

  async list(documentId: string, companyId: string): Promise<SettlementView[]> {
    const { rows } = await this.db.query<SettlementView>(
      `SELECT s.*, t.transaction_date::text, t.description AS transaction_description, t.bank_reference, t.amount::text AS transaction_amount
       FROM document_settlements s
       JOIN bank_transactions t ON t.id=s.bank_transaction_id AND t.company_id=s.company_id
       WHERE s.document_id=$1 AND s.company_id=$2
       ORDER BY s.created_at DESC`,
      [documentId, companyId],
    );
    return rows;
  }

  async settlement(id: string, documentId: string, companyId: string, client: PoolClient, lock = false): Promise<SettlementRow | null> {
    const { rows } = await client.query<SettlementRow>(
      `SELECT * FROM document_settlements WHERE id=$1 AND document_id=$2 AND company_id=$3${lock ? ' FOR UPDATE' : ''}`,
      [id, documentId, companyId],
    );
    return rows[0] ?? null;
  }

  async create(input: { companyId: string; documentId: string; transactionId: string; amount: string; actor: string; note: string | null }, client: PoolClient): Promise<SettlementRow> {
    const { rows } = await client.query<SettlementRow>(
      `INSERT INTO document_settlements(company_id,document_id,bank_transaction_id,amount,created_by_user_id,note)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.companyId, input.documentId, input.transactionId, input.amount, input.actor, input.note],
    );
    return rows[0]!;
  }

  async delete(id: string, documentId: string, companyId: string, client: PoolClient): Promise<void> {
    await client.query('DELETE FROM document_settlements WHERE id=$1 AND document_id=$2 AND company_id=$3', [id, documentId, companyId]);
  }
}

export class DocumentSettlementService {
  private readonly repo: DocumentSettlementRepository;
  private readonly audit = new AuditLogRepository();

  constructor(private readonly db: Pool) {
    this.repo = new DocumentSettlementRepository(db);
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async summary(documentId: string, companyId: string) {
    const document = await this.repo.document(documentId, companyId);
    if (!document) throw new DocumentSettlementNotFoundError('Document not found');
    const [settledAmount, settlements] = await Promise.all([
      this.repo.settledTotal(documentId, companyId),
      this.repo.list(documentId, companyId),
    ]);
    const total = document.total_amount === null ? null : moneyToCents(document.total_amount);
    const settled = moneyToCents(settledAmount);
    const remaining = total === null ? null : total > settled ? total - settled : 0n;
    const paymentStatus = total === null || settled === 0n ? 'unpaid' : settled < total ? 'partially_paid' : 'paid';
    return {
      document: { id: document.id, status: document.status, original_filename: document.original_filename, total_amount: document.total_amount },
      settled_amount: centsToMoney(settled),
      remaining_amount: remaining === null ? null : centsToMoney(remaining),
      payment_status: paymentStatus,
      settlements,
    };
  }

  async create(documentId: string, companyId: string, actor: string, transactionId: string, amount: string, note: string | null) {
    return this.tx(async (client) => {
      const document = await this.repo.document(documentId, companyId, client, true);
      if (!document) throw new DocumentSettlementNotFoundError('Document not found');
      if (document.status !== 'approved') throw new DocumentSettlementConflictError('Document must be approved before settlement');
      if (document.total_amount === null) throw new DocumentSettlementConflictError('Document total amount is required before settlement');

      const transaction = await this.repo.transaction(transactionId, companyId, client, true);
      if (!transaction) throw new DocumentSettlementNotFoundError('Bank transaction not found');
      const match = await this.repo.match(transactionId, documentId, companyId, client);
      if (!match) throw new DocumentSettlementConflictError('Bank transaction must be matched to this document first');

      const before = moneyToCents(await this.repo.settledTotal(documentId, companyId, client));
      const requested = moneyToCents(amount);
      const total = moneyToCents(document.total_amount);
      if (before + requested > total) throw new DocumentSettlementConflictError('Settlement amount exceeds document remaining amount');

      const settlement = await this.repo.create({ companyId, documentId, transactionId, amount, actor, note }, client);
      const after = before + requested;
      await this.audit.logEvent({
        company_id: companyId,
        actor_user_id: actor,
        action: 'document_settlement.create',
        entity_type: 'document_settlement',
        entity_id: settlement.id,
        before_data: { document_id: documentId, settled_amount: centsToMoney(before) },
        after_data: { document_id: documentId, bank_transaction_id: transactionId, amount, settled_amount: centsToMoney(after), note },
      }, client);
      return { settlement, settled_amount: centsToMoney(after), remaining_amount: centsToMoney(total - after) };
    }).catch((error) => {
      if ((error as { code?: string }).code === '23505') throw new DocumentSettlementConflictError('Bank transaction already has a settlement');
      if ((error as { code?: string }).code === '23503') throw new DocumentSettlementConflictError('Settlement relationship is no longer valid');
      throw error;
    });
  }

  async delete(documentId: string, settlementId: string, companyId: string, actor: string, reason: string) {
    return this.tx(async (client) => {
      const document = await this.repo.document(documentId, companyId, client, true);
      if (!document) throw new DocumentSettlementNotFoundError('Document not found');
      const settlement = await this.repo.settlement(settlementId, documentId, companyId, client, true);
      if (!settlement) throw new DocumentSettlementNotFoundError('Settlement not found');
      const before = moneyToCents(await this.repo.settledTotal(documentId, companyId, client));
      await this.repo.delete(settlementId, documentId, companyId, client);
      const settlementAmount = moneyToCents(settlement.amount);
      const after = before > settlementAmount ? before - settlementAmount : 0n;
      await this.audit.logEvent({
        company_id: companyId,
        actor_user_id: actor,
        action: 'document_settlement.delete',
        entity_type: 'document_settlement',
        entity_id: settlementId,
        before_data: { document_id: documentId, bank_transaction_id: settlement.bank_transaction_id, amount: settlement.amount, settled_amount: centsToMoney(before) },
        after_data: { document_id: documentId, settled_amount: centsToMoney(after), reason },
      }, client);
      return { status: 'deleted' as const, settled_amount: centsToMoney(after) };
    });
  }
}

function handleError(error: unknown, res: Response): boolean {
  if (error instanceof DocumentSettlementValidationError) { res.status(400).json({ error: error.message }); return true; }
  if (error instanceof DocumentSettlementNotFoundError) { res.status(404).json({ error: error.message }); return true; }
  if (error instanceof DocumentSettlementConflictError) { res.status(409).json({ error: error.message }); return true; }
  return false;
}

documentSettlementRouter.get('/documents/:id/settlements', requireAuth, requireActiveCompany, requireCapability(VIEW), asyncRoute(async (req, res) => {
  const context = activeContext(req, res); if (!context) return;
  const documentId = parseId(req.params.id);
  if (!documentId) { res.status(400).json({ error: 'Invalid document id' }); return; }
  const service = serviceOr503(res); if (!service) return;
  try { res.json(await service.summary(documentId, context.activeCompanyId)); } catch (error) { if (!handleError(error, res)) throw error; }
}));

documentSettlementRouter.post('/documents/:id/settlements', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(SETTLE), asyncRoute(async (req, res) => {
  const context = activeContext(req, res); if (!context) return;
  const documentId = parseId(req.params.id); const body = parseCreateBody(req.body);
  if (!documentId || !body) { res.status(400).json({ error: 'Invalid settlement request' }); return; }
  const service = serviceOr503(res); if (!service) return;
  try { res.status(201).json(await service.create(documentId, context.activeCompanyId, context.user.id, body.transactionId, body.amount, body.note)); } catch (error) { if (!handleError(error, res)) throw error; }
}));

documentSettlementRouter.delete('/documents/:documentId/settlements/:settlementId', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(SETTLE), asyncRoute(async (req, res) => {
  const context = activeContext(req, res); if (!context) return;
  const documentId = parseId(req.params.documentId); const settlementId = parseId(req.params.settlementId); const body = parseDeleteBody(req.body);
  if (!documentId || !settlementId || !body) { res.status(400).json({ error: 'Invalid settlement deletion request' }); return; }
  const service = serviceOr503(res); if (!service) return;
  try { res.json(await service.delete(documentId, settlementId, context.activeCompanyId, context.user.id, body.reason)); } catch (error) { if (!handleError(error, res)) throw error; }
}));
