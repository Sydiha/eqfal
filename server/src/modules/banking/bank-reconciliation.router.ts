import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool, PoolClient } from 'pg';
import pool from '../../db/pool';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { AuthSessionContext } from '../auth/session.service';

export const bankReconciliationRouter = Router();

const VIEW = 'bank.view';
const MATCH = 'bank.match';
const RECONCILE = 'bank.reconcile';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ActiveAuthContext = AuthSessionContext & { activeCompanyId: string };
type ReconciliationStatus = 'unmatched' | 'matched' | 'reconciled';
type BankTransaction = {
  id: string;
  company_id: string;
  reconciliation_status: ReconciliationStatus;
  reconciled_by_user_id: string | null;
  reconciled_at: Date | null;
};
type MatchRow = {
  id: string;
  company_id: string;
  bank_transaction_id: string;
  document_id: string;
  matched_by_user_id: string;
  matched_at: Date;
  note: string | null;
};
type CandidateDocument = {
  id: string;
  status: string;
  document_type: string | null;
  counterparty_name: string | null;
  document_date: string | null;
  reference_number: string | null;
  total_amount: string | null;
  original_filename: string;
};

export class BankReconciliationNotFoundError extends Error {}
export class BankReconciliationConflictError extends Error {}
export class BankReconciliationValidationError extends Error {}

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

function serviceOr503(res: Response): BankReconciliationService | null {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable' });
    return null;
  }
  return new BankReconciliationService(pool);
}

function parseId(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null;
}

function parseMatchBody(body: unknown): { documentId: string; note: string | null } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const x = body as Record<string, unknown>;
  if (Object.keys(x).some((k) => !['document_id', 'note'].includes(k))) return null;
  const documentId = parseId(x.document_id);
  if (!documentId) return null;
  if (x.note !== undefined && x.note !== null && typeof x.note !== 'string') return null;
  const note = typeof x.note === 'string' ? x.note.trim() || null : null;
  if (note && note.length > 500) return null;
  return { documentId, note };
}

function parseReconciliationBody(body: unknown): { status: 'matched' | 'reconciled' } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const x = body as Record<string, unknown>;
  if (Object.keys(x).length !== 1 || (x.status !== 'matched' && x.status !== 'reconciled')) return null;
  return { status: x.status };
}

class BankReconciliationRepository {
  constructor(private readonly db: Pool) {}

  async transaction(id: string, companyId: string, client?: PoolClient, lock = false): Promise<BankTransaction | null> {
    const db = client ?? this.db;
    const { rows } = await db.query<BankTransaction>(
      `SELECT id, company_id, reconciliation_status, reconciled_by_user_id, reconciled_at
       FROM bank_transactions WHERE id=$1 AND company_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [id, companyId],
    );
    return rows[0] ?? null;
  }

  async match(transactionId: string, companyId: string, client?: PoolClient): Promise<MatchRow | null> {
    const db = client ?? this.db;
    const { rows } = await db.query<MatchRow>(
      'SELECT * FROM bank_transaction_matches WHERE bank_transaction_id=$1 AND company_id=$2',
      [transactionId, companyId],
    );
    return rows[0] ?? null;
  }

  async document(id: string, companyId: string, client?: PoolClient): Promise<CandidateDocument | null> {
    const db = client ?? this.db;
    const { rows } = await db.query<CandidateDocument>(
      `SELECT id,status,document_type,counterparty_name,document_date,reference_number,total_amount,original_filename
       FROM documents WHERE id=$1 AND company_id=$2`,
      [id, companyId],
    );
    return rows[0] ?? null;
  }

  async candidates(companyId: string, search: string): Promise<CandidateDocument[]> {
    const term = search.trim().slice(0, 100);
    const params: unknown[] = [companyId];
    let filter = "status IN ('needs_review','approved')";
    if (term) {
      params.push(`%${term}%`);
      filter += ` AND (original_filename ILIKE $2 OR COALESCE(counterparty_name,'') ILIKE $2 OR COALESCE(reference_number,'') ILIKE $2)`;
    }
    const { rows } = await this.db.query<CandidateDocument>(
      `SELECT id,status,document_type,counterparty_name,document_date,reference_number,total_amount,original_filename
       FROM documents
       WHERE company_id=$1 AND ${filter}
       ORDER BY CASE WHEN status='approved' THEN 0 ELSE 1 END, document_date DESC NULLS LAST, created_at DESC
       LIMIT 50`,
      params,
    );
    return rows;
  }

  async createMatch(input: { companyId: string; transactionId: string; documentId: string; actor: string; note: string | null }, client: PoolClient): Promise<MatchRow> {
    const { rows } = await client.query<MatchRow>(
      `INSERT INTO bank_transaction_matches(company_id,bank_transaction_id,document_id,matched_by_user_id,note)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [input.companyId, input.transactionId, input.documentId, input.actor, input.note],
    );
    return rows[0]!;
  }

  async deleteMatch(transactionId: string, companyId: string, client: PoolClient): Promise<void> {
    await client.query('DELETE FROM bank_transaction_matches WHERE bank_transaction_id=$1 AND company_id=$2', [transactionId, companyId]);
  }

  async setStatus(transactionId: string, companyId: string, status: ReconciliationStatus, actor: string | null, client: PoolClient): Promise<void> {
    await client.query(
      `UPDATE bank_transactions
       SET reconciliation_status=$3,
           reconciled_by_user_id=CASE WHEN $3='reconciled' THEN $4::uuid ELSE NULL END,
           reconciled_at=CASE WHEN $3='reconciled' THEN NOW() ELSE NULL END
       WHERE id=$1 AND company_id=$2`,
      [transactionId, companyId, status, actor],
    );
  }
}

export class BankReconciliationService {
  private readonly repo: BankReconciliationRepository;
  private readonly audit = new AuditLogRepository();

  constructor(private readonly db: Pool) {
    this.repo = new BankReconciliationRepository(db);
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

  async candidates(transactionId: string, companyId: string, search: string) {
    const transaction = await this.repo.transaction(transactionId, companyId);
    if (!transaction) throw new BankReconciliationNotFoundError('Bank transaction not found');
    const [match, documents] = await Promise.all([this.repo.match(transactionId, companyId), this.repo.candidates(companyId, search)]);
    return { transaction, match, documents };
  }

  async match(transactionId: string, companyId: string, actor: string, documentId: string, note: string | null) {
    return this.tx(async (client) => {
      const transaction = await this.repo.transaction(transactionId, companyId, client, true);
      if (!transaction) throw new BankReconciliationNotFoundError('Bank transaction not found');
      if (transaction.reconciliation_status !== 'unmatched') throw new BankReconciliationConflictError('Bank transaction is already matched');
      const document = await this.repo.document(documentId, companyId, client);
      if (!document) throw new BankReconciliationNotFoundError('Document not found');
      if (document.status !== 'needs_review' && document.status !== 'approved') throw new BankReconciliationConflictError('Document is not eligible for matching');
      const match = await this.repo.createMatch({ companyId, transactionId, documentId, actor, note }, client);
      await this.repo.setStatus(transactionId, companyId, 'matched', null, client);
      await this.audit.logEvent({
        company_id: companyId,
        actor_user_id: actor,
        action: 'bank_transaction.match',
        entity_type: 'bank_transaction',
        entity_id: transactionId,
        before_data: { reconciliation_status: 'unmatched', document_id: null },
        after_data: { reconciliation_status: 'matched', document_id: documentId, note },
      }, client);
      return { status: 'matched' as const, match };
    }).catch((error) => {
      if ((error as { code?: string }).code === '23505') throw new BankReconciliationConflictError('Bank transaction is already matched');
      throw error;
    });
  }

  async unmatch(transactionId: string, companyId: string, actor: string) {
    return this.tx(async (client) => {
      const transaction = await this.repo.transaction(transactionId, companyId, client, true);
      if (!transaction) throw new BankReconciliationNotFoundError('Bank transaction not found');
      if (transaction.reconciliation_status === 'reconciled') throw new BankReconciliationConflictError('Reopen reconciliation before unmatching');
      if (transaction.reconciliation_status !== 'matched') throw new BankReconciliationConflictError('Bank transaction is not matched');
      const match = await this.repo.match(transactionId, companyId, client);
      if (!match) throw new BankReconciliationConflictError('Bank transaction match is missing');
      await this.repo.deleteMatch(transactionId, companyId, client);
      await this.repo.setStatus(transactionId, companyId, 'unmatched', null, client);
      await this.audit.logEvent({
        company_id: companyId,
        actor_user_id: actor,
        action: 'bank_transaction.unmatch',
        entity_type: 'bank_transaction',
        entity_id: transactionId,
        before_data: { reconciliation_status: 'matched', document_id: match.document_id },
        after_data: { reconciliation_status: 'unmatched', document_id: null },
      }, client);
      return { status: 'unmatched' as const };
    });
  }

  async reconcile(transactionId: string, companyId: string, actor: string, requested: 'matched' | 'reconciled') {
    return this.tx(async (client) => {
      const transaction = await this.repo.transaction(transactionId, companyId, client, true);
      if (!transaction) throw new BankReconciliationNotFoundError('Bank transaction not found');
      const match = await this.repo.match(transactionId, companyId, client);
      if (!match) throw new BankReconciliationConflictError('Bank transaction must be matched first');

      if (requested === 'reconciled') {
        if (transaction.reconciliation_status !== 'matched') throw new BankReconciliationConflictError('Invalid reconciliation transition');
        const document = await this.repo.document(match.document_id, companyId, client);
        if (!document) throw new BankReconciliationNotFoundError('Document not found');
        if (document.status !== 'approved') throw new BankReconciliationConflictError('Document must be approved before reconciliation');
        await this.repo.setStatus(transactionId, companyId, 'reconciled', actor, client);
        await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'bank_transaction.reconcile', entity_type: 'bank_transaction', entity_id: transactionId, before_data: { reconciliation_status: 'matched', document_id: match.document_id }, after_data: { reconciliation_status: 'reconciled', document_id: match.document_id } }, client);
        return { status: 'reconciled' as const };
      }

      if (transaction.reconciliation_status !== 'reconciled') throw new BankReconciliationConflictError('Invalid reconciliation transition');
      await this.repo.setStatus(transactionId, companyId, 'matched', null, client);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'bank_transaction.reopen_reconciliation', entity_type: 'bank_transaction', entity_id: transactionId, before_data: { reconciliation_status: 'reconciled', document_id: match.document_id }, after_data: { reconciliation_status: 'matched', document_id: match.document_id } }, client);
      return { status: 'matched' as const };
    });
  }
}

function handleError(error: unknown, res: Response): boolean {
  if (error instanceof BankReconciliationValidationError) { res.status(400).json({ error: error.message }); return true; }
  if (error instanceof BankReconciliationNotFoundError) { res.status(404).json({ error: error.message }); return true; }
  if (error instanceof BankReconciliationConflictError) { res.status(409).json({ error: error.message }); return true; }
  return false;
}

bankReconciliationRouter.get('/bank-transactions/:id/match-candidates', requireAuth, requireActiveCompany, requireCapability(VIEW), asyncRoute(async (req, res) => {
  const context = activeContext(req, res); if (!context) return;
  const transactionId = parseId(req.params.id); if (!transactionId) { res.status(400).json({ error: 'Invalid bank transaction id' }); return; }
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  const service = serviceOr503(res); if (!service) return;
  try { res.json(await service.candidates(transactionId, context.activeCompanyId, search)); } catch (error) { if (!handleError(error, res)) throw error; }
}));

bankReconciliationRouter.post('/bank-transactions/:id/match', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(MATCH), asyncRoute(async (req, res) => {
  const context = activeContext(req, res); if (!context) return;
  const transactionId = parseId(req.params.id); const body = parseMatchBody(req.body);
  if (!transactionId || !body) { res.status(400).json({ error: 'Invalid bank transaction match' }); return; }
  const service = serviceOr503(res); if (!service) return;
  try { res.status(201).json(await service.match(transactionId, context.activeCompanyId, context.user.id, body.documentId, body.note)); } catch (error) { if (!handleError(error, res)) throw error; }
}));

bankReconciliationRouter.delete('/bank-transactions/:id/match', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(MATCH), asyncRoute(async (req, res) => {
  const context = activeContext(req, res); if (!context) return;
  const transactionId = parseId(req.params.id); if (!transactionId) { res.status(400).json({ error: 'Invalid bank transaction id' }); return; }
  const service = serviceOr503(res); if (!service) return;
  try { res.json(await service.unmatch(transactionId, context.activeCompanyId, context.user.id)); } catch (error) { if (!handleError(error, res)) throw error; }
}));

bankReconciliationRouter.post('/bank-transactions/:id/reconciliation', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(RECONCILE), asyncRoute(async (req, res) => {
  const context = activeContext(req, res); if (!context) return;
  const transactionId = parseId(req.params.id); const body = parseReconciliationBody(req.body);
  if (!transactionId || !body) { res.status(400).json({ error: 'Invalid reconciliation request' }); return; }
  const service = serviceOr503(res); if (!service) return;
  try { res.json(await service.reconcile(transactionId, context.activeCompanyId, context.user.id, body.status)); } catch (error) { if (!handleError(error, res)) throw error; }
}));
