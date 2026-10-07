import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import pool from '../../db/pool';
import { operationalDate } from '../../operational-date';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';

// Read-only AR/AP aging built on the existing obligation model. Same "open" semantics as
// the obligations summary: confirmed, not cancelled, remaining amount above zero.
// Everything is evaluated as of an explicit date: obligations recognized after it and
// settlements whose bank transaction is dated after it do not count.
export const AGING_BUCKETS = ['current', 'days_1_30', 'days_31_60', 'days_61_90', 'days_over_90'] as const;
export type AgingBucket = typeof AGING_BUCKETS[number];
export type AgingDirection = 'receivable' | 'payable';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export class AgingValidationError extends Error {}

const validDate = (value: string) => {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const cents = (value: string) => { const [whole, fraction = ''] = value.split('.'); const sign = whole!.startsWith('-') ? -1n : 1n; return sign * (BigInt(whole!.replace('-', '')) * 100n + BigInt((fraction + '00').slice(0, 2))); };
const money = (value: bigint) => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${((value < 0n ? -value : value) % 100n).toString().padStart(2, '0')}`;
const dayNumber = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10))) / 86_400_000;

// Days past due as of the report date; no due date or not yet due counts as current.
export const agingBucket = (daysOverdue: number): AgingBucket =>
  daysOverdue <= 0 ? 'current' : daysOverdue <= 30 ? 'days_1_30' : daysOverdue <= 60 ? 'days_31_60' : daysOverdue <= 90 ? 'days_61_90' : 'days_over_90';

type Row = { id: string; direction: AgingDirection; counterparty_id: string; counterparty_name: string; source_type: string; document_id: string | null; recognized_on: string; due_on: string | null; original_amount: string; settled_amount: string };

export class ObligationAgingService {
  constructor(private db: Pool) {}

  async report(companyId: string, asOf: string) {
    if (!validDate(asOf)) throw new AgingValidationError('Invalid as_of_date');
    const rows = (await this.db.query<Row>(
      `SELECT o.id,o.direction,o.counterparty_id,c.name counterparty_name,o.source_type,o.document_id,
              o.recognized_on::text,o.due_on::text,o.original_amount::text,
              CASE WHEN o.source_type='document'
                THEN COALESCE((SELECT SUM(s.amount) FROM document_settlements s JOIN bank_transactions t ON t.id=s.bank_transaction_id AND t.company_id=s.company_id
                               WHERE s.document_id=o.document_id AND s.company_id=o.company_id AND t.transaction_date<=$2::date),0)
                ELSE COALESCE((SELECT SUM(s.amount) FROM obligation_settlements s JOIN bank_transactions t ON t.id=s.bank_transaction_id AND t.company_id=s.company_id
                               WHERE s.obligation_id=o.id AND s.company_id=o.company_id AND t.transaction_date<=$2::date),0)
              END::text settled_amount
       FROM obligations o
       JOIN counterparties c ON c.id=o.counterparty_id AND c.company_id=o.company_id
       WHERE o.company_id=$1 AND NOT o.is_cancelled AND o.verification_status='confirmed' AND o.recognized_on<=$2::date
       ORDER BY o.due_on NULLS FIRST,o.recognized_on,o.id`,
      [companyId, asOf],
    )).rows;
    const side = (direction: AgingDirection) => {
      const totals = Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket, 0n])) as Record<AgingBucket, bigint>;
      const items = rows.filter((row) => row.direction === direction).flatMap((row) => {
        const outstanding = cents(row.original_amount) - cents(row.settled_amount);
        if (outstanding <= 0n) return [];
        const daysOverdue = row.due_on ? Math.max(0, dayNumber(asOf) - dayNumber(row.due_on)) : 0;
        const bucket = agingBucket(daysOverdue);
        totals[bucket] += outstanding;
        return [{
          obligation_id: row.id, counterparty_id: row.counterparty_id, counterparty_name: row.counterparty_name,
          source_type: row.source_type, document_id: row.document_id, recognized_on: row.recognized_on, due_on: row.due_on,
          original_amount: row.original_amount, settled_amount: money(cents(row.settled_amount)), outstanding_amount: money(outstanding),
          days_overdue: daysOverdue, bucket,
        }];
      });
      const total = AGING_BUCKETS.reduce((sum, bucket) => sum + totals[bucket], 0n);
      return {
        buckets: AGING_BUCKETS.map((bucket) => ({ bucket, amount: money(totals[bucket]), count: items.filter((item) => item.bucket === bucket).length })),
        total_outstanding: money(total),
        item_count: items.length,
        items,
      };
    };
    return { as_of_date: asOf, receivables: side('receivable'), payables: side('payable') };
  }
}

export const obligationAgingRouter = Router();
const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => (req, res, next: NextFunction) => void handler(req, res).catch(next);
obligationAgingRouter.get('/obligations/aging', requireAuth, requireActiveCompany, requireCapability('obligation.view'), route(async (req, res) => {
  const raw = req.query.as_of_date;
  if (raw !== undefined && typeof raw !== 'string') { res.status(400).json({ error: 'Invalid request' }); return; }
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return; }
  try {
    const companyId = getAuthenticatedContext(req)!.activeCompanyId!;
    res.json(await new ObligationAgingService(pool).report(companyId, raw ?? operationalDate()));
  } catch (error) {
    if (error instanceof AgingValidationError) { res.status(400).json({ error: 'Invalid request' }); return; }
    throw error;
  }
}));
