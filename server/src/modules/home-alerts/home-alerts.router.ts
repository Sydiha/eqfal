import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import pool from '../../db/pool';
import { operationalDate } from '../../operational-date';
import { getAuthenticatedContext, requireActiveCompany, requireAuth } from '../auth/auth.middleware';

export const homeAlertsRouter = Router();

type AlertClass = 'needs_action_now' | 'upcoming_due' | 'needs_review_completion';
type AlertOwnership = 'current_user' | 'waiting_for_accountant' | 'waiting_for_team' | 'upcoming';
type Destination = 'obligations' | 'documents' | 'banks';
export type HomeAlert = {
  key: string;
  class: AlertClass;
  ownership: AlertOwnership;
  count: number;
  destination: Destination;
  parameters: Record<string, string>;
};

const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => void handler(req, res).catch(next);

const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const ownsAction = (capabilities: readonly string[], capability: string, otherwise: AlertOwnership): AlertOwnership =>
  capabilities.includes(capability) ? 'current_user' : otherwise;

export class HomeAlertsService {
  constructor(private db: Pool) {}

  async list(companyId: string, capabilities: readonly string[]) {
    const alerts: HomeAlert[] = [];
    const today = operationalDate();
    const dueThrough = addDays(today, 30);

    if (capabilities.includes('obligation.view')) {
      const { rows } = await this.db.query<{ overdue: string; upcoming: string; unconfirmed: string }>(`WITH remaining AS (
        SELECT o.id,o.due_on,o.verification_status,o.is_cancelled,
          o.original_amount-COALESCE(CASE WHEN o.source_type='document' THEN ds.settled ELSE os.settled END,0) remaining
        FROM obligations o
        LEFT JOIN (SELECT company_id,obligation_id,SUM(amount) settled FROM obligation_settlements GROUP BY company_id,obligation_id) os
          ON os.company_id=o.company_id AND os.obligation_id=o.id
        LEFT JOIN (SELECT company_id,document_id,SUM(amount) settled FROM document_settlements GROUP BY company_id,document_id) ds
          ON ds.company_id=o.company_id AND ds.document_id=o.document_id
        WHERE o.company_id=$1
      ) SELECT
        COUNT(*) FILTER (WHERE NOT is_cancelled AND remaining>0 AND due_on<$2)::text overdue,
        COUNT(*) FILTER (WHERE NOT is_cancelled AND remaining>0 AND due_on BETWEEN $2 AND $3)::text upcoming,
        COUNT(*) FILTER (WHERE NOT is_cancelled AND remaining>0 AND verification_status='unconfirmed')::text unconfirmed
      FROM remaining`, [companyId, today, dueThrough]);
      const counts = rows[0] ?? { overdue: '0', upcoming: '0', unconfirmed: '0' };
      alerts.push(
        { key: 'overdue_obligations', class: 'needs_action_now', ownership: ownsAction(capabilities, 'obligation.settlement.create', 'waiting_for_accountant'), count: Number(counts.overdue), destination: 'obligations', parameters: { overdue: '1' } },
        { key: 'upcoming_obligations', class: 'upcoming_due', ownership: 'upcoming', count: Number(counts.upcoming), destination: 'obligations', parameters: { dueFrom: today, dueTo: dueThrough } },
        { key: 'unconfirmed_obligations', class: 'needs_review_completion', ownership: ownsAction(capabilities, 'obligation.confirm', 'waiting_for_team'), count: Number(counts.unconfirmed), destination: 'obligations', parameters: { confirmation: 'unconfirmed' } },
      );
    }

    if (capabilities.includes('document.view')) {
      const { rows } = await this.db.query<{ status: string; count: string }>(
        "SELECT status,COUNT(*)::text count FROM documents WHERE company_id=$1 AND status IN ('uploaded','needs_review','incomplete') GROUP BY status",
        [companyId],
      );
      const counts = new Map(rows.map(row => [row.status, Number(row.count)]));
      for (const status of ['uploaded', 'needs_review', 'incomplete']) {
        const ownership = status === 'incomplete'
          ? ownsAction(capabilities, 'document.edit', 'waiting_for_team')
          : ownsAction(capabilities, 'document.review', 'waiting_for_accountant');
        alerts.push({ key: `documents_${status}`, class: 'needs_review_completion', ownership, count: counts.get(status) ?? 0, destination: 'documents', parameters: { status } });
      }
    }

    if (capabilities.includes('bank.view')) {
      const { rows } = await this.db.query<{ reconciliation_status: string; count: string }>(
        "SELECT reconciliation_status,COUNT(*)::text count FROM bank_transactions WHERE company_id=$1 AND reconciliation_status IN ('unmatched','matched') GROUP BY reconciliation_status",
        [companyId],
      );
      const counts = new Map(rows.map(row => [row.reconciliation_status, Number(row.count)]));
      for (const status of ['unmatched', 'matched']) {
        const capability = status === 'unmatched' ? 'bank.match' : 'bank.reconcile';
        alerts.push({ key: `bank_transactions_${status}`, class: 'needs_review_completion', ownership: ownsAction(capabilities, capability, 'waiting_for_accountant'), count: counts.get(status) ?? 0, destination: 'banks', parameters: { section: 'transactions', reconciliation: status } });
      }
    }

    return { as_of: today, alerts };
  }
}

function service(res: Response) {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable' });
    return null;
  }
  return new HomeAlertsService(pool);
}

homeAlertsRouter.get('/home-alerts', requireAuth, requireActiveCompany, route(async (req, res) => {
  const context = getAuthenticatedContext(req)!;
  const value = service(res);
  if (value && context.activeCompanyId) res.json(await value.list(context.activeCompanyId, context.capabilities));
}));
