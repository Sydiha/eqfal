import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import pool from '../../db/pool';
import { operationalDate } from '../../operational-date';
import { getAuthenticatedContext, requireActiveCompany, requireAuth } from '../auth/auth.middleware';

export const managerFinancialSnapshotRouter = Router();

type Metric = { state: 'available'; amount: string } | { state: 'hidden' };
type BankAccountMetric = {
  id: string;
  display_name: string;
  currency_code: string;
  balance: { state: 'available'; amount: string } | { state: 'unavailable' };
};

const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => void handler(req, res).catch(next);

const monthBounds = (date: string) => {
  const [year, month] = date.split('-').map(Number);
  const start = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return { start, next };
};

export type SnapshotPeriodScope = { periodId?: string; fiscalYearId?: string; month?: string };

export class SnapshotPeriodNotFoundError extends Error {}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ManagerFinancialSnapshotService {
  constructor(private db: Pool) {}

  // Boundaries come from the company's own monthly_close_periods (one period) or fiscal_years (whole year / one calendar month).
  private async resolveRange(companyId: string, scope: SnapshotPeriodScope) {
    const { rows } = scope.periodId
      ? await this.db.query<{ start: string; next: string }>(`SELECT period_start::text start,(period_end+1)::text next
          FROM monthly_close_periods WHERE company_id=$1 AND id=$2`, [companyId, scope.periodId])
      : scope.month
        ? await this.db.query<{ start: string; next: string }>(`SELECT GREATEST(start_date,$3::date)::text start,
            LEAST(end_date+1,($3::date+interval '1 month')::date)::text next
            FROM fiscal_years WHERE company_id=$1 AND id=$2
              AND start_date < ($3::date+interval '1 month')::date AND end_date >= $3::date`, [companyId, scope.fiscalYearId, `${scope.month}-01`])
        : await this.db.query<{ start: string | null; next: string | null }>(`SELECT start_date::text start,(end_date+1)::text next
            FROM fiscal_years WHERE company_id=$1 AND id=$2`, [companyId, scope.fiscalYearId]);
    const row = rows[0];
    if (!row?.start || !row.next) throw new SnapshotPeriodNotFoundError();
    return { start: row.start, next: row.next };
  }

  async get(companyId: string, capabilities: readonly string[], scope: SnapshotPeriodScope = {}) {
    const asOf = operationalDate();
    const { start, next } = scope.periodId || scope.fiscalYearId
      ? await this.resolveRange(companyId, scope)
      : monthBounds(asOf);
    let bankAccounts: BankAccountMetric[] | null = null;
    let receivables: Metric = { state: 'hidden' };
    let payables: Metric = { state: 'hidden' };
    let sales: Metric = { state: 'hidden' };
    let purchasesExpenses: Metric = { state: 'hidden' };

    if (capabilities.includes('bank.view')) {
      const { rows } = await this.db.query<{ id: string; display_name: string; currency_code: string; running_balance: string | null }>(`SELECT a.id,a.display_name,a.currency_code,b.running_balance::text
        FROM bank_accounts a
        LEFT JOIN LATERAL (
          SELECT t.running_balance
          FROM bank_transactions t
          WHERE t.company_id=a.company_id AND t.bank_account_id=a.id AND t.running_balance IS NOT NULL
          ORDER BY t.transaction_date DESC,t.source_row_number DESC,t.created_at DESC,t.id DESC
          LIMIT 1
        ) b ON TRUE
        WHERE a.company_id=$1
        ORDER BY a.display_name,a.id`, [companyId]);
      bankAccounts = rows.map(account => ({
        id: account.id,
        display_name: account.display_name,
        currency_code: account.currency_code,
        balance: account.running_balance === null
          ? { state: 'unavailable' }
          : { state: 'available', amount: account.running_balance },
      }));
    }

    if (capabilities.includes('obligation.view')) {
      const { rows } = await this.db.query<{ direction: 'receivable' | 'payable'; amount: string }>(`WITH remaining AS (
          SELECT o.direction,GREATEST(o.original_amount-COALESCE(CASE WHEN o.source_type='document' THEN ds.settled ELSE os.settled END,0),0) amount
          FROM obligations o
          LEFT JOIN (SELECT company_id,obligation_id,SUM(amount) settled FROM obligation_settlements GROUP BY company_id,obligation_id) os
            ON os.company_id=o.company_id AND os.obligation_id=o.id
          LEFT JOIN (SELECT company_id,document_id,SUM(amount) settled FROM document_settlements GROUP BY company_id,document_id) ds
            ON ds.company_id=o.company_id AND ds.document_id=o.document_id
          WHERE o.company_id=$1 AND NOT o.is_cancelled AND o.verification_status='confirmed'
        )
        SELECT direction,COALESCE(SUM(amount),0)::text amount FROM remaining GROUP BY direction`, [companyId]);
      const amounts = new Map(rows.map(row => [row.direction, row.amount]));
      receivables = { state: 'available', amount: amounts.get('receivable') ?? '0' };
      payables = { state: 'available', amount: amounts.get('payable') ?? '0' };
    }

    if (capabilities.includes('document.view') && capabilities.includes('obligation.view')) {
      const { rows } = await this.db.query<{ sales: string; purchases_expenses: string }>(`SELECT
          COALESCE(SUM(total_amount) FILTER (WHERE document_type='sale'),0)::text sales,
          COALESCE(SUM(total_amount) FILTER (WHERE document_type IN ('purchase','expense')),0)::text purchases_expenses
        FROM documents
        WHERE company_id=$1 AND status='approved' AND document_date >= $2 AND document_date < $3
          AND document_type IN ('sale','purchase','expense')`, [companyId, start, next]);
      sales = { state: 'available', amount: rows[0]?.sales ?? '0' };
      purchasesExpenses = { state: 'available', amount: rows[0]?.purchases_expenses ?? '0' };
    }

    return {
      as_of: asOf,
      month: { start, end_exclusive: next },
      metrics: {
        bank_balances: bankAccounts === null ? { state: 'hidden' as const } : { state: 'available' as const, accounts: bankAccounts },
        amounts_to_collect: receivables,
        amounts_to_pay: payables,
        current_month_sales: sales,
        current_month_purchases_expenses: purchasesExpenses,
      },
    };
  }
}

function service(res: Response) {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable' });
    return null;
  }
  return new ManagerFinancialSnapshotService(pool);
}

managerFinancialSnapshotRouter.get('/manager-financial-snapshot', requireAuth, requireActiveCompany, route(async (req, res) => {
  const context = getAuthenticatedContext(req)!;
  const value = service(res);
  const periodId = typeof req.query.period_id === 'string' ? req.query.period_id : undefined;
  const fiscalYearId = typeof req.query.fiscal_year_id === 'string' ? req.query.fiscal_year_id : undefined;
  const month = typeof req.query.month === 'string' ? req.query.month : undefined;
  if ((periodId && !UUID_RE.test(periodId)) || (fiscalYearId && !UUID_RE.test(fiscalYearId)) || (month && (!MONTH_RE.test(month) || !fiscalYearId))) {
    res.status(400).json({ error: 'Invalid period' });
    return;
  }
  if (!value || !context.activeCompanyId) return;
  try {
    res.json(await value.get(context.activeCompanyId, context.capabilities, periodId ? { periodId } : { fiscalYearId, month }));
  } catch (error) {
    if (error instanceof SnapshotPeriodNotFoundError) res.status(404).json({ error: 'Period not found' });
    else throw error;
  }
}));
