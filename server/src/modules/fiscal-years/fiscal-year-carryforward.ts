import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable } from '../monthly-close/accounting-period.guard';

/**
 * Year-end carry-forward (explicit, review-gated).
 *
 * Ledger design this is compatible with: every statement and the trial balance are computed per fiscal_year_id from POSTED journals of that
 * year only, and a year's brought-forward position is its single `opening_balance` journal (opening-balances module). So no closing journal is
 * written and no posted history is touched: the next year's opening balance is PROPOSED here from the closed year's final trial balance
 * (balance-sheet accounts carried at their net balance; revenue/expense accounts netted into the retained-earnings account the caller names),
 * as a DRAFT opening balance review. Posting stays in the existing submit / approve flow (opening_balance.approve), nothing is posted here.
 * The prior year keeps its own statements unchanged (comparatives preserved); the new year starts with zero P&L and opening equity that
 * already contains the prior result, so nothing is counted twice.
 */
export class CarryforwardBlockedError extends Error {
  constructor(public readonly code: string, message: string, public readonly blockers: Array<{ code: string; detail?: string }> = []) { super(message); }
}
export class CarryforwardValidationError extends Error {}
export class CarryforwardNotFoundError extends Error {}

type Year = { id: string; name: string; start_date: string; end_date: string; status: 'open' | 'closed' };
type NetRow = { account_id: string; code: string; name: string; account_type: string; is_active: boolean; net: string };
export type CarryLine = { account_id: string; code: string; name: string; account_type: string; category: 'other_asset' | 'other_liability' | 'equity'; side: 'debit' | 'credit'; amount: string; is_active: boolean };

const cents = (value: string): bigint => {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const v = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -v : v;
};
const money = (value: bigint): string => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
const CATEGORY = { asset: 'other_asset', liability: 'other_liability', equity: 'equity' } as const;

async function loadYear(client: Pick<PoolClient, 'query'>, companyId: string, id: string, lock: boolean): Promise<Year> {
  const row = (await client.query<Year>(
    `SELECT id,name,start_date::text,end_date::text,status FROM fiscal_years WHERE id=$1 AND company_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, companyId])).rows[0];
  if (!row) throw new CarryforwardNotFoundError();
  return row;
}
async function nextYear(client: Pick<PoolClient, 'query'>, companyId: string, from: Year, lock: boolean): Promise<Year | null> {
  return (await client.query<Year>(
    `SELECT id,name,start_date::text,end_date::text,status FROM fiscal_years WHERE company_id=$1 AND start_date=($2::date + 1)${lock ? ' FOR UPDATE' : ''}`,
    [companyId, from.end_date])).rows[0] ?? null;
}

/** Final trial balance of the closed year: net (debit - credit) per account over all its posted journals, opening journal included. */
async function finalBalances(client: Pick<PoolClient, 'query'>, companyId: string, yearId: string): Promise<NetRow[]> {
  return (await client.query<NetRow>(
    `SELECT a.id account_id,a.code,a.name,a.account_type,a.is_active,SUM(l.debit-l.credit)::text net
     FROM journal_lines l
     JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
     JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
     WHERE l.company_id=$1 AND j.fiscal_year_id=$2 AND j.status='posted'
     GROUP BY a.id,a.code,a.name,a.account_type,a.is_active
     HAVING SUM(l.debit-l.credit)<>0
     ORDER BY a.code,a.id`, [companyId, yearId])).rows;
}

type RetainedRef = { id: string; code: string; name: string; is_active: boolean };

/** Pure netting of a closed year's final balances into the carried lines (debit-positive halalas), shared by prepare and the reconciliation checks. */
function carryNets(rows: NetRow[], retainedAccount: RetainedRef | null) {
  // Result of the year = net of all revenue/expense accounts (credit-positive profit). Balance-sheet accounts are carried as they stand.
  let result = 0n; // debit-positive net of P&L accounts; profit is negative here
  const carried = new Map<string, { row: NetRow; net: bigint }>();
  for (const r of rows) {
    const net = cents(r.net);
    if (r.account_type === 'revenue' || r.account_type === 'expense') result += net;
    else carried.set(r.account_id, { row: r, net });
  }
  const netResult = -result; // profit > 0, loss < 0
  // ONE net line per account: the retained-earnings account's own closing balance and the year's result are consolidated
  // (debit-positive arithmetic), so profit/loss, zero balances and a debit<->credit sign change all come out as a single side.
  if (retainedAccount && netResult !== 0n) {
    const existing = carried.get(retainedAccount.id);
    carried.set(retainedAccount.id, {
      row: existing?.row ?? { account_id: retainedAccount.id, code: retainedAccount.code, name: retainedAccount.name, account_type: 'equity', is_active: retainedAccount.is_active, net: '0' },
      net: (existing?.net ?? 0n) - netResult,
    });
  }
  return { carried, netResult };
}

/** Per-account debit-positive net in halalas; zero nets are kept so an extra account is still reported. */
export type AccountNets = Map<string, { code: string; net: bigint }>;
export type CarryMismatch = { account_id: string; code: string; expected: string; actual: string };

const signed = (net: bigint) => (net === 0n ? 'none' : `${net > 0n ? 'debit' : 'credit'}:${money(net < 0n ? -net : net)}`);

/**
 * Expected opening position of the next year, recomputed from the closed year's authoritative posted ledger (never from the stored proposal).
 * `empty` = nothing to carry: no balance-sheet balance and a zero result.
 */
export async function expectedCarryforward(client: Pick<PoolClient, 'query'>, companyId: string, fromYearId: string, retainedAccountId: string | null) {
  const rows = await finalBalances(client, companyId, fromYearId);
  const retained = retainedAccountId
    ? (await client.query<RetainedRef>('SELECT id,code,name,is_active FROM accounts WHERE id=$1 AND company_id=$2', [retainedAccountId, companyId])).rows[0] ?? null
    : null;
  const { carried, netResult } = carryNets(rows, retained);
  const nets: AccountNets = new Map([...carried.values()].filter(({ net }) => net !== 0n).map(({ row, net }) => [row.account_id, { code: row.code, net }]));
  const unbalanced = rows.reduce((sum, r) => sum + cents(r.net), 0n) !== 0n;
  return { nets, netResult, unbalanced, empty: nets.size === 0 && netResult === 0n };
}

/** Exact (integer halalah) comparison: every account, side and amount must match; missing and extra accounts are both mismatches. */
export function carryforwardMismatches(expected: AccountNets, actual: AccountNets): CarryMismatch[] {
  const ids = new Set([...expected.keys(), ...actual.keys()]);
  const out: CarryMismatch[] = [];
  for (const id of ids) {
    const e = expected.get(id), a = actual.get(id);
    if (e && a && e.net === a.net) continue;
    out.push({ account_id: id, code: (e ?? a)!.code, expected: signed(e?.net ?? 0n), actual: a ? signed(a.net) : 'missing' });
  }
  return out.sort((x, y) => x.code.localeCompare(y.code) || x.account_id.localeCompare(y.account_id));
}

/** Debit-positive net per account of a query returning (account_id, code, net::text). */
export async function accountNets(client: Pick<PoolClient, 'query'>, sql: string, params: unknown[]): Promise<AccountNets> {
  const rows = (await client.query<{ account_id: string; code: string; net: string }>(sql, params)).rows;
  return new Map(rows.map((r) => [r.account_id, { code: r.code, net: cents(r.net) }]));
}

/**
 * B1 (Owner policy F2): a carry-forward opening balance review may be reviewed, but it may only be posted when the review's items AND the
 * journal being posted equal, exactly, the carry-forward recomputed from the originating closed year's posted ledger. Ordinary opening
 * balance reviews (no carry-forward record) return null and are not affected. Runs inside the posting transaction (review already locked).
 */
export async function verifyCarryforwardReview(client: Pick<PoolClient, 'query'>, companyId: string, reviewId: string, journalId: string) {
  const record = (await client.query<{ from_fiscal_year_id: string; retained_earnings_account_id: string }>(
    'SELECT from_fiscal_year_id,retained_earnings_account_id FROM fiscal_year_carryforwards WHERE company_id=$1 AND opening_balance_review_id=$2',
    [companyId, reviewId])).rows[0];
  if (!record) return null;
  // FOR SHARE: the originating year cannot change state while the comparison is made; it must still be closed.
  const from = (await client.query<{ status: string }>('SELECT status FROM fiscal_years WHERE id=$1 AND company_id=$2 FOR SHARE', [record.from_fiscal_year_id, companyId])).rows[0];
  if (!from || from.status !== 'closed') return { reason: 'SOURCE_YEAR_NOT_CLOSED', mismatches: [] as CarryMismatch[] };
  const expected = await expectedCarryforward(client, companyId, record.from_fiscal_year_id, record.retained_earnings_account_id);
  if (expected.unbalanced) return { reason: 'SOURCE_LEDGER_UNBALANCED', mismatches: [] as CarryMismatch[] };
  const items = await accountNets(client,
    `SELECT i.account_id,a.code,SUM(CASE WHEN i.balance_side='debit' THEN i.amount ELSE -i.amount END)::text net
     FROM opening_balance_items i JOIN accounts a ON a.id=i.account_id AND a.company_id=i.company_id
     WHERE i.company_id=$1 AND i.review_id=$2 GROUP BY i.account_id,a.code`, [companyId, reviewId]);
  const journal = await accountNets(client,
    `SELECT l.account_id,a.code,SUM(l.debit-l.credit)::text net
     FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
     WHERE l.company_id=$1 AND l.journal_entry_id=$2 GROUP BY l.account_id,a.code`, [companyId, journalId]);
  const mismatches = carryforwardMismatches(expected.nets, items);
  for (const m of carryforwardMismatches(expected.nets, journal)) if (!mismatches.some((x) => x.account_id === m.account_id)) mismatches.push(m);
  return mismatches.length ? { reason: 'CARRYFORWARD_RECONCILIATION_MISMATCH', mismatches } : null;
}

async function compute(client: Pick<PoolClient, 'query'>, companyId: string, from: Year, to: Year | null, retainedAccount: { id: string; code: string; name: string; account_type: string; is_active: boolean } | null) {
  const rows = await finalBalances(client, companyId, from.id);
  const blockers: Array<{ code: string; detail?: string }> = [];
  const totalNet = rows.reduce((sum, r) => sum + cents(r.net), 0n);
  if (totalNet !== 0n) blockers.push({ code: 'TRIAL_BALANCE_UNBALANCED', detail: money(totalNet) });
  if (from.status !== 'closed') blockers.push({ code: 'FISCAL_YEAR_NOT_CLOSED' });
  if (!to) blockers.push({ code: 'NEXT_FISCAL_YEAR_MISSING' });
  else if (to.status !== 'open') blockers.push({ code: 'NEXT_FISCAL_YEAR_CLOSED' });
  if (to) {
    if ((await client.query('SELECT 1 FROM opening_balance_reviews WHERE company_id=$1 AND fiscal_year_id=$2', [companyId, to.id])).rowCount
      || (await client.query("SELECT 1 FROM journal_entries WHERE company_id=$1 AND fiscal_year_id=$2 AND entry_type='opening_balance'", [companyId, to.id])).rowCount) {
      blockers.push({ code: 'OPENING_BALANCE_ALREADY_EXISTS' });
    }
  }

  const { carried, netResult } = carryNets(rows, retainedAccount);
  const lines: CarryLine[] = [...carried.values()].filter(({ net }) => net !== 0n).sort((x, y) => x.row.code.localeCompare(y.row.code)).map(({ row, net }) => ({
    account_id: row.account_id, code: row.code, name: row.name, account_type: row.account_type,
    category: CATEGORY[row.account_type as keyof typeof CATEGORY], side: net > 0n ? 'debit' : 'credit' as 'debit' | 'credit',
    amount: money(net < 0n ? -net : net), is_active: row.is_active,
  }));
  if (!lines.length && (netResult === 0n || retainedAccount)) blockers.push({ code: 'NOTHING_TO_CARRY' });
  for (const l of lines) if (!l.is_active) blockers.push({ code: 'CARRY_ACCOUNT_INACTIVE', detail: l.code });
  const all = lines;
  const debit = all.filter((l) => l.side === 'debit').reduce((s, l) => s + cents(l.amount), 0n);
  const credit = all.filter((l) => l.side === 'credit').reduce((s, l) => s + cents(l.amount), 0n);
  return { blockers, lines, netResult, debit, credit, balanced: retainedAccount || netResult === 0n ? debit === credit : null };
}

async function retainedEarningsAccount(client: Pick<PoolClient, 'query'>, companyId: string, id: unknown) {
  if (typeof id !== 'string') throw new CarryforwardValidationError('A retained-earnings account is required');
  const acc = (await client.query<{ id: string; code: string; name: string; account_type: string; is_active: boolean; statement_category: string }>(
    'SELECT id,code,name,account_type,is_active,statement_category FROM accounts WHERE id=$1 AND company_id=$2', [id, companyId])).rows[0];
  if (!acc) throw new CarryforwardValidationError('Retained-earnings account not found in this company');
  if (acc.account_type !== 'equity' || acc.statement_category !== 'equity') throw new CarryforwardValidationError('Retained-earnings account must be an equity account classified as equity');
  return acc;
}

export class FiscalYearCarryforwardService {
  private audit = new AuditLogRepository();
  constructor(private db: Pool) {}

  /** Read-only preview (REPEATABLE READ so the numbers and the blockers come from one snapshot). */
  async preview(companyId: string, fromYearId: string, retainedAccountId?: string) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const from = await loadYear(client, companyId, fromYearId, false);
      const to = await nextYear(client, companyId, from, false);
      const retained = retainedAccountId ? await retainedEarningsAccount(client, companyId, retainedAccountId) : null;
      const existing = (await client.query(
        'SELECT id,to_fiscal_year_id,opening_balance_review_id,retained_earnings_account_id,net_result::text,total_debit::text,total_credit::text,item_count,prepared_by,created_at FROM fiscal_year_carryforwards WHERE company_id=$1 AND from_fiscal_year_id=$2', [companyId, from.id])).rows[0] ?? null;
      const c = await compute(client, companyId, from, to, retained);
      await client.query('COMMIT');
      return {
        from_year: from, to_year: to, existing, ready: !existing && c.blockers.length === 0 && retained !== null,
        blockers: existing ? [{ code: 'CARRYFORWARD_ALREADY_PREPARED' }, ...c.blockers] : c.blockers,
        net_result: money(c.netResult), lines: c.lines,
        total_debit: money(c.debit), total_credit: money(c.credit), balanced: c.balanced,
      };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  /** Creates ONE draft opening balance review for the next year. Idempotent: a second call is refused, nothing is duplicated. */
  async prepare(companyId: string, fromYearId: string, actor: string, retainedAccountId: unknown) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const from = await loadYear(client, companyId, fromYearId, true);
      const to = await nextYear(client, companyId, from, true);
      // A closed next year is reported by compute() as the NEXT_FISCAL_YEAR_CLOSED blocker; the writable guard covers the open-year case (closed first month).
      if (to && to.status === 'open') await assertAccountingDateWritable(companyId, to.start_date, client);
      const retained = await retainedEarningsAccount(client, companyId, retainedAccountId);
      if ((await client.query('SELECT 1 FROM fiscal_year_carryforwards WHERE company_id=$1 AND (from_fiscal_year_id=$2 OR to_fiscal_year_id=$3)', [companyId, from.id, to?.id ?? null])).rowCount) {
        throw new CarryforwardBlockedError('CARRYFORWARD_ALREADY_PREPARED', 'A carry-forward was already prepared for these fiscal years');
      }
      const c = await compute(client, companyId, from, to, retained);
      if (c.blockers.length) throw new CarryforwardBlockedError('CARRYFORWARD_BLOCKED', 'Carry-forward is blocked', c.blockers);
      const all = c.lines;
      if (c.debit !== c.credit) throw new CarryforwardBlockedError('CARRYFORWARD_UNBALANCED', 'Carry-forward lines are not balanced');

      const review = (await client.query(
        'INSERT INTO opening_balance_reviews(company_id,fiscal_year_id,prepared_by) VALUES($1,$2,$3) RETURNING *', [companyId, to!.id, actor])).rows[0];
      for (const l of all) {
        const isResult = l.account_id === retained.id && c.netResult !== 0n;
        await client.query(
          `INSERT INTO opening_balance_items(company_id,review_id,category,account_id,amount,balance_side,source_type,source_reference,confidence,note,created_by)
           VALUES($1,$2,$3,$4,$5,$6,'internal_ledger',$7,'high',$8,$9)`,
          [companyId, review.id, l.category, l.account_id, l.amount, l.side, `fiscal_year:${from.id}`,
            isResult ? `Closing balance of ${from.name} consolidated with its net result (${money(c.netResult)})` : `Closing balance of ${from.name}`, actor]);
      }
      const record = (await client.query(
        `INSERT INTO fiscal_year_carryforwards(company_id,from_fiscal_year_id,to_fiscal_year_id,opening_balance_review_id,retained_earnings_account_id,net_result,total_debit,total_credit,item_count,prepared_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [companyId, from.id, to!.id, review.id, retained.id, money(c.netResult), money(c.debit), money(c.credit), all.length, actor])).rows[0];
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'opening_balance.create', entity_type: 'opening_balance_review', entity_id: review.id, before_data: null, after_data: review }, client);
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'fiscal_year.carryforward.prepare', entity_type: 'fiscal_year', entity_id: from.id, before_data: null,
        after_data: { to_fiscal_year_id: to!.id, opening_balance_review_id: review.id, retained_earnings_account_id: retained.id, net_result: money(c.netResult), total_debit: money(c.debit), total_credit: money(c.credit), item_count: all.length },
      }, client);
      await client.query('COMMIT');
      return { carryforward: record, review, items: all };
    } catch (error) {
      await client.query('ROLLBACK');
      // A concurrent manual opening-balance review or a second prepare hits the unique constraints: report it as the same conflict.
      if ((error as { code?: string }).code === '23505') throw new CarryforwardBlockedError('CARRYFORWARD_ALREADY_PREPARED', 'A carry-forward or opening balance already exists for the next fiscal year');
      throw error;
    } finally { client.release(); }
  }
}
