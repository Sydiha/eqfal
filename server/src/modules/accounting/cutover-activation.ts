import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { lockAccountingRange } from '../monthly-close/accounting-period.guard';
import { postJournalInTransaction } from './journal-posting';
import { LedgerSourceAuthorityNotFoundError } from './ledger-source-authority';

/**
 * C1B-3b: preview and atomic activation of a mid-year cut-over.
 *
 * A DRAFT range [fiscal-year start, D] becomes ACTIVE only together with one posted, balanced `cutover_balance` journal dated D that carries the
 * approved closing trial balance at ACCOUNT level (retained earnings BEFORE the period profit; profit and loss from the year start to D).
 * Nothing here decides whether the source trial balance is correct: EQFAL validates structure and records the preparer, the trial-balance
 * reference and the accountant's acknowledgements. It is not an accounting certificate.
 *
 * Lock order (identical to migration 086's trigger): company authority -> VAT periods -> accounting months [start..D] ascending. The journal is
 * created and posted WHILE THE RANGE IS STILL DRAFT (the 083 posting guards read active ranges only), then the range is flipped to active.
 */

export type Finding = { code: string; detail?: unknown };
export class CutoverValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly findings: Finding[] = []) { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY = /^(0|[1-9]\d{0,12})(\.\d{1,2})?$/;
const QUARTER_ENDS = new Set(['03-31', '06-30', '09-30', '12-31']);
const CASH_NAME = /(bank|cash|petty|صندوق|نقد|بنك|مصرف)/i;
const RESERVED_MEMOS = new Set(['VAT_INPUT', 'VAT_OUTPUT']);

export const ACKNOWLEDGEMENT_KEYS = [
  'retained_earnings_before_period_profit',
  'pnl_from_year_start_to_cutover',
  'cash_matches_statements',
  'account_level_only',
] as const;

export type CutoverInput = {
  lines: Array<{ account_id: string; debit: string; credit: string; memo: string | null }>;
  retained_earnings_account_id: string;
  prepared_by: string;
  trial_balance_reference: string;
  acknowledgements: Record<(typeof ACKNOWLEDGEMENT_KEYS)[number], boolean>;
  cash_non_cash_confirmed_account_ids: string[];
};

const cents = (value: string): bigint => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')); };
const money = (value: bigint): string => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
const plusDay = (date: string): string => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const isMonthEnd = (date: string): boolean => plusDay(date).endsWith('-01');

/** Strict request-body parser: unknown keys, wrong types and malformed amounts are rejected (400), never coerced. */
export function parseCutoverInput(body: unknown, mode: 'preview' | 'activate' = 'activate'): CutoverInput {
  const bad = (message: string) => new CutoverValidationError('CUTOVER_INPUT_INVALID', message);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('Invalid request');
  const x = body as Record<string, unknown>;
  const allowed = ['lines', 'retained_earnings_account_id', 'prepared_by', 'trial_balance_reference', 'acknowledgements', 'cash_non_cash_confirmed_account_ids', 'confirm'];
  if (Object.keys(x).some((key) => !allowed.includes(key))) throw bad('Unknown field');
  const text = (value: unknown, max: number, code: string): string => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new CutoverValidationError(code, 'A required text field is missing or too long');
    return value.trim();
  };
  const preview = mode === 'preview';
  const prepared_by = preview && (x['prepared_by'] === undefined || x['prepared_by'] === '') ? '' : text(x['prepared_by'], 200, 'CUTOVER_PREPARER_REQUIRED');
  const trial_balance_reference = preview && (x['trial_balance_reference'] === undefined || x['trial_balance_reference'] === '') ? '' : text(x['trial_balance_reference'], 300, 'CUTOVER_TB_REFERENCE_REQUIRED');
  if (typeof x['retained_earnings_account_id'] !== 'string' || !UUID.test(x['retained_earnings_account_id'])) throw new CutoverValidationError('CUTOVER_RETAINED_EARNINGS_INVALID', 'A retained-earnings account is required');
  if (!Array.isArray(x['lines']) || x['lines'].length < 2 || x['lines'].length > 2000) throw new CutoverValidationError('CUTOVER_LINES_INVALID', 'Between 2 and 2000 trial-balance lines are required');
  const lines = (x['lines'] as unknown[]).map((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new CutoverValidationError('CUTOVER_LINES_INVALID', 'Invalid line');
    const l = raw as Record<string, unknown>;
    if (Object.keys(l).some((key) => !['account_id', 'debit', 'credit', 'memo'].includes(key))) throw new CutoverValidationError('CUTOVER_LINES_INVALID', 'Unknown line field');
    const amount = (value: unknown): string => {
      const v = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
      if (typeof v !== 'string' || !MONEY.test(v)) throw new CutoverValidationError('CUTOVER_LINES_INVALID', 'Amounts must be non-negative with at most two decimals');
      return v;
    };
    if (typeof l['account_id'] !== 'string' || !UUID.test(l['account_id'])) throw new CutoverValidationError('CUTOVER_LINES_INVALID', 'Invalid account');
    const debit = amount(l['debit'] ?? '0'), credit = amount(l['credit'] ?? '0');
    if ((cents(debit) > 0n) === (cents(credit) > 0n)) throw new CutoverValidationError('CUTOVER_LINES_INVALID', 'Each line carries exactly one of debit or credit');
    const memo = l['memo'] === undefined || l['memo'] === null ? null : typeof l['memo'] === 'string' && l['memo'].length <= 500 ? l['memo'] : (() => { throw new CutoverValidationError('CUTOVER_LINES_INVALID', 'Invalid memo'); })();
    return { account_id: l['account_id'].toLowerCase(), debit, credit, memo };
  });
  const ack = x['acknowledgements'] ?? (preview ? {} : undefined);
  if (typeof ack !== 'object' || ack === null || Array.isArray(ack) || Object.keys(ack).some((key) => !(ACKNOWLEDGEMENT_KEYS as readonly string[]).includes(key))) {
    throw new CutoverValidationError('CUTOVER_ACK_REQUIRED', 'All accountant acknowledgements are required');
  }
  const acknowledgements = {} as CutoverInput['acknowledgements'];
  for (const key of ACKNOWLEDGEMENT_KEYS) {
    const given = (ack as Record<string, unknown>)[key] === true;
    if (!given && !preview) throw new CutoverValidationError('CUTOVER_ACK_REQUIRED', `Acknowledgement "${key}" must be explicitly true`);
    acknowledgements[key] = given;
  }
  const confirmed = x['cash_non_cash_confirmed_account_ids'] ?? [];
  if (!Array.isArray(confirmed) || confirmed.some((id) => typeof id !== 'string' || !UUID.test(id))) throw bad('Invalid cash confirmation list');
  return {
    lines, retained_earnings_account_id: (x['retained_earnings_account_id'] as string).toLowerCase(), prepared_by, trial_balance_reference, acknowledgements,
    cash_non_cash_confirmed_account_ids: (confirmed as string[]).map((id) => id.toLowerCase()),
  };
}

type RangeRow = { id: string; company_id: string; from_date: string; to_date: string; status: string; reason: string };
type AccountRow = { id: string; code: string; name: string; name_ar: string | null; name_en: string | null; account_type: string; statement_category: string; is_active: boolean; cash_role: string };

export class CutoverActivationService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  /** Read-only preview: the same checks the activation runs, with the computed figures the accountant must confirm. Takes no accounting lock. */
  async preview(companyId: string, rangeId: string, input: CutoverInput) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await this.evaluate(client, companyId, rangeId, input);
      await client.query('COMMIT');
      return this.shape(result);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async activate(companyId: string, actor: string, rangeId: string, input: CutoverInput) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const peek = (await client.query<RangeRow>('SELECT id,company_id,from_date::text,to_date::text,status,reason FROM ledger_source_authority WHERE id=$1 AND company_id=$2', [rangeId, companyId])).rows[0];
      if (!peek) throw new LedgerSourceAuthorityNotFoundError();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`source-authority:${companyId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`vat-periods:${companyId}`]);
      await lockAccountingRange(companyId, peek.from_date, peek.to_date, client);

      const result = await this.evaluate(client, companyId, rangeId, input, true);
      if (result.blockers.length) {
        throw new CutoverValidationError(result.blockers[0]!.code, 'The cut-over cannot be activated', result.blockers);
      }
      const { range, year, sums, lines, vat } = result;
      const journal = (await client.query<{ id: string }>(
        `INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,reference,entry_type,status,created_by)
         VALUES($1,$2,$3,$4,$5,'cutover_balance','draft',$6) RETURNING id`,
        [companyId, year.id, range.to_date, `Cut-over opening position at ${range.to_date}`, input.trial_balance_reference.slice(0, 200), actor],
      )).rows[0]!;
      let sequence = 1;
      for (const line of lines) {
        await client.query(
          'INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [companyId, journal.id, line.account_id, line.debit, line.credit, line.memo, sequence++],
        );
      }
      await postJournalInTransaction(client, companyId, actor, journal.id, { cutoverRangeId: range.id });

      const acknowledgement = {
        prepared_by: input.prepared_by,
        trial_balance_reference: input.trial_balance_reference,
        acknowledgements: input.acknowledgements,
        cash_non_cash_confirmed_account_ids: input.cash_non_cash_confirmed_account_ids,
        retained_earnings_account_id: input.retained_earnings_account_id,
        totals: { debit: money(sums.debit), credit: money(sums.credit), line_count: lines.length },
        vat,
        warnings: result.warnings.map((warning) => warning.code),
        activated_by_user_id: actor,
      };
      const activated = (await client.query(
        `UPDATE ledger_source_authority SET status='active',cutover_journal_id=$3,activated_by=$4,activated_at=NOW(),activation_ack=$5::jsonb
         WHERE id=$1 AND company_id=$2 AND status='draft' RETURNING id,from_date::text,to_date::text,status,cutover_journal_id,activated_by,activated_at`,
        [range.id, companyId, journal.id, actor, JSON.stringify(acknowledgement)],
      )).rows[0];
      if (!activated) throw new CutoverValidationError('CUTOVER_RANGE_NOT_DRAFT', 'The range is no longer a draft');
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'ledger_source_authority.activate', entity_type: 'ledger_source_authority', entity_id: range.id,
        before_data: { status: 'draft', from_date: range.from_date, to_date: range.to_date },
        after_data: { status: 'active', from_date: range.from_date, to_date: range.to_date, cutover_journal_id: journal.id, fiscal_year_id: year.id, ...acknowledgement },
        reason: range.reason,
      }, client);
      await client.query('COMMIT');
      return { range: activated, journal_id: journal.id, totals: acknowledgement.totals, warnings: result.warnings };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof Error && /^[A-Z][A-Z_]{7,}$/.test(error.message)) {
        // A database guard (migration 086/083) refused: surface its stable code instead of a generic failure.
        throw new CutoverValidationError(error.message, 'The database refused the activation');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private shape(result: Awaited<ReturnType<CutoverActivationService['evaluate']>>) {
    return {
      ready: result.blockers.length === 0,
      range: result.range, fiscal_year: result.year, native_posting_starts: plusDay(result.range.to_date),
      totals: { debit: money(result.sums.debit), credit: money(result.sums.credit), balanced: result.sums.debit === result.sums.credit && result.sums.debit > 0n, line_count: result.lines.length },
      equity: result.equity, profit_or_loss_through_cutover: result.pnl, cash: result.cash, vat: result.vat,
      blockers: result.blockers, warnings: result.warnings,
    };
  }

  private async evaluate(client: PoolClient, companyId: string, rangeId: string, input: CutoverInput, forUpdate = false) {
    if (!UUID.test(rangeId)) throw new LedgerSourceAuthorityNotFoundError();
    const blockers: Finding[] = [];
    const warnings: Finding[] = [];
    const block = (code: string, detail?: unknown) => { blockers.push(detail === undefined ? { code } : { code, detail }); };
    const warn = (code: string, detail?: unknown) => { warnings.push(detail === undefined ? { code } : { code, detail }); };

    const range = (await client.query<RangeRow>(
      `SELECT id,company_id,from_date::text,to_date::text,status,reason FROM ledger_source_authority WHERE id=$1 AND company_id=$2${forUpdate ? ' FOR UPDATE' : ''}`, [rangeId, companyId],
    )).rows[0];
    if (!range) throw new LedgerSourceAuthorityNotFoundError();
    if (range.status !== 'draft') throw new CutoverValidationError('CUTOVER_RANGE_NOT_DRAFT', 'Only a draft range can be activated');
    const cutover = range.to_date;
    if (!isMonthEnd(cutover)) block('CUTOVER_DATE_NOT_MONTH_END');

    const year = (await client.query<{ id: string; start_date: string; end_date: string; status: string }>(
      'SELECT id,start_date::text,end_date::text,status FROM fiscal_years WHERE company_id=$1 AND start_date=$2::date', [companyId, range.from_date],
    )).rows[0];
    if (!year || year.status !== 'open' || cutover >= year.end_date) {
      throw new CutoverValidationError('CUTOVER_FISCAL_YEAR_INVALID', 'The range must start on the first day of an open fiscal year and end before its last day');
    }

    // --- Trial balance structure ---------------------------------------------------------------------------------------------------------------
    const ids = input.lines.map((line) => line.account_id);
    if (new Set(ids).size !== ids.length) block('CUTOVER_LINES_DUPLICATE_ACCOUNT');
    const accounts = new Map((await client.query<AccountRow>(
      `SELECT id,code,name,name_ar,name_en,account_type,statement_category,is_active,cash_role FROM accounts WHERE company_id=$1 AND id=ANY($2::uuid[])`, [companyId, ids],
    )).rows.map((row) => [row.id, row]));
    const unknown = ids.filter((id) => !accounts.has(id));
    if (unknown.length) block('CUTOVER_ACCOUNT_INVALID', { reason: 'not_in_company', account_ids: unknown });
    const unusable = [...accounts.values()].filter((a) => !a.is_active || a.statement_category === 'unmapped').map((a) => ({ code: a.code, reason: !a.is_active ? 'inactive' : 'unmapped' }));
    if (unusable.length) block('CUTOVER_ACCOUNT_INVALID', { reason: 'inactive_or_unmapped', accounts: unusable });
    if (input.lines.some((line) => line.memo !== null && RESERVED_MEMOS.has(line.memo.trim().toUpperCase()))) block('CUTOVER_MEMO_RESERVED');

    let debit = 0n, credit = 0n;
    for (const line of input.lines) { debit += cents(line.debit); credit += cents(line.credit); }
    const sums = { debit, credit };
    if (debit !== credit || debit <= 0n) block('CUTOVER_UNBALANCED', { debit: money(debit), credit: money(credit) });

    // --- Equity: retained earnings BEFORE the period profit ------------------------------------------------------------------------------------
    const net = (accountId: string): bigint => input.lines.filter((l) => l.account_id === accountId).reduce((sum, l) => sum + cents(l.credit) - cents(l.debit), 0n);
    const retained = accounts.get(input.retained_earnings_account_id);
    if (!retained || retained.account_type !== 'equity' || retained.statement_category !== 'equity' || !ids.includes(input.retained_earnings_account_id)) {
      block('CUTOVER_RETAINED_EARNINGS_INVALID');
    }
    let pnlNet = 0n, revenue = 0n, expense = 0n;
    for (const line of input.lines) {
      const account = accounts.get(line.account_id);
      if (!account) continue;
      const credited = cents(line.credit) - cents(line.debit);
      if (account.account_type === 'revenue') { pnlNet += credited; revenue += credited; }
      else if (account.account_type === 'expense') { pnlNet += credited; expense += -credited; }
    }
    const retainedBalance = retained ? net(retained.id) : 0n;
    const otherEquity = input.lines.filter((l) => accounts.get(l.account_id)?.account_type === 'equity' && l.account_id !== input.retained_earnings_account_id)
      .reduce((sum, l) => sum + cents(l.credit) - cents(l.debit), 0n);
    for (const account of accounts.values()) {
      if (account.account_type === 'equity' && account.id !== input.retained_earnings_account_id && pnlNet !== 0n) {
        const balance = net(account.id);
        if (balance === pnlNet || balance === -pnlNet) warn('CUTOVER_EQUITY_MIRRORS_PERIOD_PROFIT', { account_code: account.code });
      }
    }
    if (pnlNet === 0n && revenue === 0n && expense === 0n && retainedBalance !== 0n) warn('CUTOVER_NO_PROFIT_AND_LOSS_ACCOUNTS');
    warn('CUTOVER_ACCOUNT_LEVEL_ONLY');

    // --- Cash classification -------------------------------------------------------------------------------------------------------------------
    const cashAccounts = [...accounts.values()].filter((a) => a.cash_role !== 'non_cash');
    const cashTotal = cashAccounts.reduce((sum, a) => sum + -net(a.id), 0n);
    const suspect = [...accounts.values()].filter((a) => a.account_type === 'asset' && a.cash_role === 'non_cash'
      && CASH_NAME.test(`${a.name} ${a.name_ar ?? ''} ${a.name_en ?? ''}`) && net(a.id) !== 0n && !input.cash_non_cash_confirmed_account_ids.includes(a.id));
    if (suspect.length) block('CUTOVER_CASH_CLASSIFICATION_SUSPECT', { accounts: suspect.map((a) => ({ id: a.id, code: a.code })) });
    if (!cashAccounts.length) warn('CUTOVER_NO_CASH_ACCOUNT');

    // --- Period conflicts ----------------------------------------------------------------------------------------------------------------------
    const exists = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rowCount! > 0;
    if (await exists('SELECT 1 FROM journal_entries WHERE company_id=$1 AND accounting_date BETWEEN $2 AND $3 LIMIT 1', [companyId, range.from_date, range.to_date])) block('CUTOVER_PERIOD_HAS_JOURNALS');
    if (await exists("SELECT 1 FROM monthly_close_periods WHERE company_id=$1 AND status='closed' AND period_start<=$3 AND period_end>=$2 LIMIT 1", [companyId, range.from_date, range.to_date])) block('CUTOVER_PERIOD_CLOSED');
    if (await exists(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM journal_entries WHERE company_id=$1 AND fiscal_year_id=$2 AND entry_type='opening_balance')
          OR EXISTS (SELECT 1 FROM opening_balance_reviews WHERE company_id=$1 AND fiscal_year_id=$2)
          OR EXISTS (SELECT 1 FROM fiscal_year_carryforwards WHERE company_id=$1 AND to_fiscal_year_id=$2)`, [companyId, year.id])) block('CUTOVER_OPENING_PATH_CONFLICT');
    if (await exists("SELECT 1 FROM annual_closing_packages WHERE company_id=$1 AND fiscal_year_id=$2 AND status='approved'", [companyId, year.id])) block('CUTOVER_ANNUAL_PACKAGE_APPROVED');
    if (await exists('SELECT 1 FROM tax_working_papers WHERE company_id=$1 AND fiscal_year_id=$2', [companyId, year.id])) warn('CUTOVER_TAX_WORKPAPER_EXISTS');

    // --- VAT filing frequency (profile that governs the first native day) ----------------------------------------------------------------------
    const nativeStart = plusDay(cutover);
    const profiles = (await client.query<{ id: string; version_no: number; vat_status: string; vat_filing_frequency: string | null; vat_registered_from: string | null; vat_deregistered_from: string | null; first_live_accounting_date: string }>(
      `SELECT id,version_no,vat_status,vat_filing_frequency,vat_registered_from::text,vat_deregistered_from::text,first_live_accounting_date::text
       FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$2::date AND (effective_to IS NULL OR effective_to>=$2::date)`,
      [companyId, nativeStart],
    )).rows;
    let vat: { profile_id: string | null; version_no: number | null; vat_status: string | null; vat_filing_frequency: string | null; cutover_is_quarter_end: boolean } =
      { profile_id: null, version_no: null, vat_status: null, vat_filing_frequency: null, cutover_is_quarter_end: QUARTER_ENDS.has(cutover.slice(5)) };
    if (profiles.length !== 1) {
      block('CUTOVER_VAT_PROFILE_AMBIGUOUS', { matching_profiles: profiles.length });
    } else {
      const profile = profiles[0]!;
      vat = { ...vat, profile_id: profile.id, version_no: profile.version_no, vat_status: profile.vat_status, vat_filing_frequency: profile.vat_filing_frequency };
      if (profile.vat_status === 'needs_review') block('CUTOVER_VAT_PROFILE_NEEDS_REVIEW');
      else {
        const notVatActive = profile.vat_status === 'not_registered' || (profile.vat_status === 'deregistered' && profile.vat_deregistered_from !== null && profile.vat_deregistered_from <= nativeStart);
        if (!notVatActive) {
          if (profile.vat_registered_from && profile.vat_registered_from > nativeStart) warn('CUTOVER_VAT_REGISTRATION_STARTS_LATER');
          if (profile.vat_filing_frequency === null) block('CUTOVER_VAT_FREQUENCY_MISSING');
          else if (profile.vat_filing_frequency === 'quarterly' && !QUARTER_ENDS.has(cutover.slice(5))) block('CUTOVER_VAT_QUARTER_BOUNDARY', { cutover_date: cutover });
        }
      }
      if (profile.first_live_accounting_date !== nativeStart) warn('CUTOVER_FIRST_LIVE_DATE_DIFFERS', { first_live_accounting_date: profile.first_live_accounting_date, expected: nativeStart });
      const later = (await client.query<{ n: string }>(
        `SELECT COUNT(*)::text n FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND id<>$4 AND effective_from<=$3::date
           AND (effective_to IS NULL OR effective_to>=$2::date) AND (vat_status IS DISTINCT FROM $5 OR vat_filing_frequency IS DISTINCT FROM $6)`,
        [companyId, nativeStart, year.end_date, profile.id, profile.vat_status, profile.vat_filing_frequency],
      )).rows[0]!.n;
      if (Number(later) > 0) warn('CUTOVER_VAT_PROFILE_CHANGES_IN_YEAR');
    }
    if (await exists('SELECT 1 FROM vat_periods WHERE company_id=$1 AND period_start<=$3 AND period_end>=$2 LIMIT 1', [companyId, range.from_date, range.to_date])) block('CUTOVER_VAT_PERIOD_CONFLICT');

    const sortedLines = [...input.lines].sort((a, b) => (accounts.get(a.account_id)?.code ?? '').localeCompare(accounts.get(b.account_id)?.code ?? '') || a.account_id.localeCompare(b.account_id));
    return {
      range, year, sums, lines: sortedLines, blockers, warnings, vat,
      equity: { retained_earnings_account_id: input.retained_earnings_account_id, retained_earnings_balance: money(retainedBalance), other_equity_total: money(otherEquity) },
      pnl: { revenue: money(revenue), expenses: money(expense), net_result: money(pnlNet) },
      cash: { total: money(cashTotal), accounts: cashAccounts.map((a) => ({ id: a.id, code: a.code, cash_role: a.cash_role, balance: money(-net(a.id)) })) },
    };
  }
}
