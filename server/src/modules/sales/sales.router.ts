import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';

export const salesRouter = Router();

type SaleRow = {
  id: string; original_filename: string; reference_number: string | null; document_date: string | null;
  total_amount: string | null; document_status: string; counterparty_id: string | null; customer_name: string | null;
  receivable_id: string | null; original_amount: string | null; collected_amount: string; due_on: string | null;
  verification_status: string | null; is_cancelled: boolean | null;
};

const cents = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
};
const money = (value: bigint) => `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;

/** Tenant-scoped operational projection over documents, receivables, and existing settlements. */
export class SalesService {
  constructor(private readonly db: Pool) {}

  async list(companyId: string, today = new Date().toISOString().slice(0, 10)) {
    const { rows } = await this.db.query<SaleRow>(
      `SELECT d.id,d.original_filename,d.reference_number,d.document_date::text,d.total_amount::text,
              d.status AS document_status,d.counterparty_id,COALESCE(c.name,d.counterparty_name) AS customer_name,
              o.id AS receivable_id,o.original_amount::text,o.due_on::text,o.verification_status,o.is_cancelled,
              COALESCE(SUM(s.amount),0)::text AS collected_amount
       FROM documents d
       LEFT JOIN counterparties c ON c.id=d.counterparty_id AND c.company_id=d.company_id
       LEFT JOIN obligations o ON o.document_id=d.id AND o.company_id=d.company_id
         AND o.direction='receivable' AND o.source_type='document'
       LEFT JOIN document_settlements s ON s.document_id=d.id AND s.company_id=d.company_id
       WHERE d.company_id=$1 AND d.document_type='sale'
       GROUP BY d.id,c.name,o.id
       ORDER BY d.document_date DESC NULLS LAST,d.created_at DESC`,
      [companyId],
    );
    const ids = rows.map((row) => row.id);
    const histories = ids.length === 0 ? [] : (await this.db.query(
      `SELECT s.id,s.document_id,s.bank_transaction_id,s.amount::text,s.note,t.transaction_date::text,
              t.description,t.bank_reference
       FROM document_settlements s
       JOIN bank_transactions t ON t.id=s.bank_transaction_id AND t.company_id=s.company_id
       WHERE s.company_id=$1 AND s.document_id=ANY($2::uuid[])
       ORDER BY t.transaction_date DESC,s.created_at DESC`,
      [companyId, ids],
    )).rows;
    return { sales: rows.map((row) => {
      const total = row.original_amount ?? row.total_amount;
      const collected = cents(row.collected_amount);
      const remaining = total === null ? null : (cents(total) > collected ? cents(total) - collected : 0n);
      const financialState = remaining !== null && remaining === 0n ? 'paid'
        : row.due_on && row.due_on < today && remaining !== null && remaining > 0n ? 'overdue'
        : collected > 0n ? 'partial' : 'open';
      return { ...row, remaining_amount: remaining === null ? null : money(remaining), financial_state: financialState,
        settlement_history: histories.filter((item) => item.document_id === row.id) };
    }) };
  }
}

const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => void handler(req, res).catch(next);

salesRouter.get('/sales', requireAuth, requireActiveCompany, requireCapability('document.view'), requireCapability('obligation.view'), route(async (req, res) => {
  const context = getAuthenticatedContext(req);
  if (!context?.activeCompanyId) { res.status(403).json({ error: 'No active company' }); return; }
  if (!pool) { res.status(503).json({ error: 'Database unavailable' }); return; }
  res.json(await new SalesService(pool).list(context.activeCompanyId));
}));
