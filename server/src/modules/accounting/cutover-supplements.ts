import { createHash } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { LedgerSourceAuthorityError, LedgerSourceAuthorityNotFoundError } from './ledger-source-authority';

/**
 * Cutover S2: pre-cut-over historical supplements (migration 091). For a fiscal year whose books up to D are one cut-over journal, the cash
 * flows and equity movements of 1 Jan -> D are entered as REPORT DATA with external evidence. They are never posted, never derived from
 * balances, and never written to the ledger. A version is draft -> approved -> superseded (or draft -> voided); approval freezes it.
 *
 * Invariants (approved spec v2, section D), all in integer minor units (halalas), exact, no tolerance:
 *   C1 every cash/cash-equivalent account of the cut-over journal has one balance line whose closing_amount equals its journal balance; no extra.
 *   C2 sum(opening) + sum(flows, fx_effect included) = sum(closing).
 *   C3 a flow line whose counterpart is a cash account is an internal transfer and is refused.
 *   C4 a flow line's account must be non_cash; a section different from the account's cash_flow_category needs a written justification.
 *   C5 amounts are in the functional currency; fx_effect is allowed only when a linked bank account is in another currency, with evidence.
 *   E1 every equity account: opening + movements = its balance in the cut-over journal (zero when absent); none missing.
 *   E2 transfers between equity accounts sum to zero.  E3 only equity accounts (the YTD result comes from the journal's P&L lines).
 *   E4 retained earnings: journal balance - (opening + movements) = 0.
 * The same evaluation runs at approval and on every report (full_year_complete is computed, never stored).
 */
export type SupplementKind = 'cash_flow' | 'equity';
export type SupplementLineType = 'cash_balance' | 'cash_flow' | 'equity_opening' | 'equity_movement';
export type FlowSection = 'operating' | 'investing' | 'financing' | 'fx_effect';
export type MovementType = 'contribution' | 'distribution' | 'transfer' | 'other';
export type SupplementLine = {
  line_type: SupplementLineType; account_id: string | null; section: FlowSection | null; movement_type: MovementType | null; label: string | null;
  amount: string | null; opening_amount: string | null; closing_amount: string | null; classification_override_reason: string | null;
};
export type SupplementInput = { source_system: string; evidence_reference: string; fx_translation_evidence: string | null; lines: SupplementLine[] };
export type SupplementIssue = { code: string; account_id?: string; line_no?: number; detail?: Record<string, string> };
export type SupplementVersion = {
  id: string; company_id: string; authority_id: string; kind: SupplementKind; version_no: number; status: 'draft' | 'approved' | 'superseded' | 'voided';
  supersedes_id: string | null; source_system: string; evidence_reference: string; fx_translation_evidence: string | null; functional_currency: string;
  prepared_by: string; prepared_at: string; row_version: number; approved_by: string | null; approved_at: string | null; cutover_journal_id: string | null;
  ledger_fingerprint: string | null; superseded_by_id: string | null; superseded_at: string | null; voided_by: string | null; voided_at: string | null; void_reason: string | null;
};

export class SupplementValidationError extends LedgerSourceAuthorityError {
  constructor(code: string, public readonly detail?: unknown) { super(code); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNED_MONEY = /^-?\d{1,16}(\.\d{1,2})?$/;
const MAX_LINES = 1000;
const SECTIONS: FlowSection[] = ['operating', 'investing', 'financing', 'fx_effect'];
const MOVEMENTS: MovementType[] = ['contribution', 'distribution', 'transfer', 'other'];
const LINE_TYPES: Record<SupplementKind, SupplementLineType[]> = { cash_flow: ['cash_balance', 'cash_flow'], equity: ['equity_opening', 'equity_movement'] };

/** Exact decimal -> integer halalas (no floating point). */
export const cents = (value: string): bigint => {
  const neg = value.startsWith('-'); const [w, f = ''] = (neg ? value.slice(1) : value).split('.');
  const v = BigInt(w!) * 100n + BigInt((f + '00').slice(0, 2)); return neg ? -v : v;
};
export const money = (value: bigint): string => { const neg = value < 0n; const a = neg ? -value : value; return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };
const text = (v: unknown, min: number, max: number): string | null => (typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);
const amountOf = (v: unknown): string | null => (typeof v === 'string' && SIGNED_MONEY.test(v.trim()) ? money(cents(v.trim())) : null);

/** Strict body parser (unknown keys, wrong shape for the kind, malformed amounts -> null => 400). */
export function parseSupplementInput(kind: SupplementKind, body: unknown): SupplementInput | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const x = body as Record<string, unknown>;
  if (Object.keys(x).some((k) => !['source_system', 'evidence_reference', 'fx_translation_evidence', 'lines', 'expected_row_version', 'confirm'].includes(k))) return null;
  const source = text(x['source_system'], 1, 200), evidence = text(x['evidence_reference'], 1, 200);
  const fx = x['fx_translation_evidence'] === undefined || x['fx_translation_evidence'] === null ? null : text(x['fx_translation_evidence'], 1, 500);
  if (!source || !evidence || (x['fx_translation_evidence'] != null && !fx)) return null;
  if (!Array.isArray(x['lines']) || x['lines'].length > MAX_LINES) return null;
  const lines: SupplementLine[] = [];
  for (const raw of x['lines'] as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const l = raw as Record<string, unknown>;
    if (Object.keys(l).some((k) => !['line_type', 'account_id', 'section', 'movement_type', 'label', 'amount', 'opening_amount', 'closing_amount', 'classification_override_reason'].includes(k))) return null;
    const type = l['line_type'] as SupplementLineType;
    if (!LINE_TYPES[kind].includes(type)) return null;
    const account = l['account_id'] === undefined || l['account_id'] === null ? null : (typeof l['account_id'] === 'string' && UUID.test(l['account_id']) ? l['account_id'].toLowerCase() : undefined);
    if (account === undefined) return null;
    const line: SupplementLine = { line_type: type, account_id: account, section: null, movement_type: null, label: null, amount: null, opening_amount: null, closing_amount: null, classification_override_reason: null };
    const allowed: Record<SupplementLineType, string[]> = {
      cash_balance: ['line_type', 'account_id', 'opening_amount', 'closing_amount'],
      cash_flow: ['line_type', 'account_id', 'section', 'label', 'amount', 'classification_override_reason'],
      equity_opening: ['line_type', 'account_id', 'opening_amount'],
      equity_movement: ['line_type', 'account_id', 'movement_type', 'label', 'amount'],
    };
    if (Object.keys(l).some((k) => !allowed[type].includes(k) && l[k] !== null)) return null;
    if (type !== 'cash_flow' && !account) return null;
    if (type === 'cash_balance' || type === 'equity_opening') {
      line.opening_amount = amountOf(l['opening_amount']); if (!line.opening_amount) return null;
      if (type === 'cash_balance') { line.closing_amount = amountOf(l['closing_amount']); if (!line.closing_amount) return null; }
    } else {
      line.amount = amountOf(l['amount']); line.label = text(l['label'], 1, 200);
      if (!line.amount || cents(line.amount) === 0n || !line.label) return null;
      if (type === 'cash_flow') {
        if (!SECTIONS.includes(l['section'] as FlowSection)) return null;
        line.section = l['section'] as FlowSection;
        if (l['classification_override_reason'] != null) {
          line.classification_override_reason = text(l['classification_override_reason'], 10, 500);
          if (!line.classification_override_reason || !account) return null;
        }
      } else {
        if (!MOVEMENTS.includes(l['movement_type'] as MovementType)) return null;
        line.movement_type = l['movement_type'] as MovementType;
      }
    }
    lines.push(line);
  }
  return { source_system: source, evidence_reference: evidence, fx_translation_evidence: fx, lines };
}

type Queryable = Pick<Pool | PoolClient, 'query'>;
export type JournalLine = { account_id: string; debit: string; credit: string; cash_role: string; cash_flow_category: string; statement_category: string };
type AccountInfo = { id: string; cash_role: string; cash_flow_category: string; statement_category: string };
export type EvaluationContext = {
  journal: JournalLine[]; accounts: Map<string, AccountInfo>; functional_currency: string | null; foreign_cash_account_ids: string[];
  retained_earnings_account_id: string | null;
};
export type Evaluation = {
  valid: boolean; issues: SupplementIssue[];
  totals: Record<string, string>;
};

/** Pure: evaluates every invariant of one supplement version against the cut-over journal (exported for unit tests). */
export function evaluateSupplement(kind: SupplementKind, version: Pick<SupplementVersion, 'functional_currency' | 'fx_translation_evidence'>, lines: SupplementLine[], ctx: EvaluationContext): Evaluation {
  const issues: SupplementIssue[] = [];
  const balance = new Map<string, bigint>();
  for (const l of ctx.journal) balance.set(l.account_id, (balance.get(l.account_id) ?? 0n) + cents(l.debit) - cents(l.credit));
  const journalAccount = new Map(ctx.journal.map((l) => [l.account_id, l]));
  const no = (index: number) => index + 1;
  if (ctx.functional_currency && version.functional_currency !== ctx.functional_currency) issues.push({ code: 'SUPPLEMENT_CURRENCY_MISMATCH', detail: { expected: ctx.functional_currency, actual: version.functional_currency } });
  if (!ctx.functional_currency) issues.push({ code: 'SUPPLEMENT_FUNCTIONAL_CURRENCY_UNKNOWN' });
  const totals: Record<string, string> = {};
  if (kind === 'cash_flow') {
    const cashAccounts = new Set(ctx.journal.filter((l) => l.cash_role !== 'non_cash').map((l) => l.account_id));
    const seen = new Set<string>();
    let opening = 0n, closing = 0n;
    const flows: Record<FlowSection, bigint> = { operating: 0n, investing: 0n, financing: 0n, fx_effect: 0n };
    lines.forEach((l, i) => {
      if (l.line_type === 'cash_balance') {
        const id = l.account_id!;
        if (seen.has(id)) { issues.push({ code: 'SUPPLEMENT_DUPLICATE_ACCOUNT', account_id: id, line_no: no(i) }); return; }
        seen.add(id);
        if (!cashAccounts.has(id)) { issues.push({ code: 'SUPPLEMENT_CASH_ACCOUNT_EXTRA', account_id: id, line_no: no(i) }); return; }
        opening += cents(l.opening_amount!); closing += cents(l.closing_amount!);
        const expected = balance.get(id) ?? 0n;
        if (cents(l.closing_amount!) !== expected) issues.push({ code: 'SUPPLEMENT_CASH_CLOSING_MISMATCH', account_id: id, line_no: no(i), detail: { expected: money(expected), actual: money(cents(l.closing_amount!)) } });
        return;
      }
      if (l.account_id) {
        const account = ctx.accounts.get(l.account_id);
        if (!account) { issues.push({ code: 'SUPPLEMENT_ACCOUNT_NOT_FOUND', account_id: l.account_id, line_no: no(i) }); return; }
        if (account.cash_role !== 'non_cash') { issues.push({ code: 'SUPPLEMENT_INTERNAL_TRANSFER_LINE', account_id: l.account_id, line_no: no(i) }); return; }
        if (l.section !== account.cash_flow_category && !l.classification_override_reason) {
          issues.push({ code: 'SUPPLEMENT_CLASSIFICATION_OVERRIDE_REQUIRED', account_id: l.account_id, line_no: no(i), detail: { account_category: account.cash_flow_category, section: l.section! } });
        }
      }
      flows[l.section!] += cents(l.amount!);
    });
    for (const id of cashAccounts) if (!seen.has(id)) issues.push({ code: 'SUPPLEMENT_CASH_ACCOUNT_MISSING', account_id: id });
    const net = flows.operating + flows.investing + flows.financing + flows.fx_effect;
    if (opening + net !== closing) issues.push({ code: 'SUPPLEMENT_CASH_ROLLFORWARD_MISMATCH', detail: { opening: money(opening), net_change: money(net), closing: money(closing), difference: money(opening + net - closing) } });
    if (flows.fx_effect !== 0n || lines.some((l) => l.section === 'fx_effect')) {
      if (!ctx.foreign_cash_account_ids.length) issues.push({ code: 'SUPPLEMENT_FX_EFFECT_NOT_ALLOWED' });
      else if (!version.fx_translation_evidence) issues.push({ code: 'SUPPLEMENT_FX_EVIDENCE_REQUIRED' });
    }
    Object.assign(totals, { opening: money(opening), operating: money(flows.operating), investing: money(flows.investing), financing: money(flows.financing), fx_effect: money(flows.fx_effect), net_change: money(net), closing: money(closing) });
  } else {
    const equityAccounts = new Set(ctx.journal.filter((l) => l.statement_category === 'equity').map((l) => l.account_id));
    const openingBy = new Map<string, bigint>(), movementBy = new Map<string, bigint>();
    let transfers = 0n, opening = 0n, movements = 0n;
    lines.forEach((l, i) => {
      const id = l.account_id!;
      const account = ctx.accounts.get(id);
      if (!account) { issues.push({ code: 'SUPPLEMENT_ACCOUNT_NOT_FOUND', account_id: id, line_no: no(i) }); return; }
      if (account.statement_category !== 'equity') { issues.push({ code: 'SUPPLEMENT_ACCOUNT_NOT_EQUITY', account_id: id, line_no: no(i) }); return; }
      if (l.line_type === 'equity_opening') {
        if (openingBy.has(id)) { issues.push({ code: 'SUPPLEMENT_DUPLICATE_ACCOUNT', account_id: id, line_no: no(i) }); return; }
        openingBy.set(id, cents(l.opening_amount!)); opening += cents(l.opening_amount!); return;
      }
      const v = cents(l.amount!);
      if ((l.movement_type === 'contribution' && v < 0n) || (l.movement_type === 'distribution' && v > 0n)) issues.push({ code: 'SUPPLEMENT_MOVEMENT_SIGN_INVALID', account_id: id, line_no: no(i) });
      if (l.movement_type === 'transfer') transfers += v;
      movementBy.set(id, (movementBy.get(id) ?? 0n) + v); movements += v;
    });
    for (const id of movementBy.keys()) if (!openingBy.has(id) && ctx.accounts.get(id)?.statement_category === 'equity') issues.push({ code: 'SUPPLEMENT_EQUITY_OPENING_MISSING', account_id: id });
    for (const id of equityAccounts) if (!openingBy.has(id)) issues.push({ code: 'SUPPLEMENT_EQUITY_ACCOUNT_MISSING', account_id: id });
    for (const [id, open] of openingBy) {
      // Equity balances are credit-natural: journal balance (debit - credit) negated.
      const expected = -(balance.get(id) ?? 0n), actual = open + (movementBy.get(id) ?? 0n);
      if (actual !== expected) {
        const re = id === ctx.retained_earnings_account_id;
        issues.push({ code: re ? 'SUPPLEMENT_RETAINED_EARNINGS_MISMATCH' : 'SUPPLEMENT_EQUITY_ROLLFORWARD_MISMATCH', account_id: id, detail: { expected: money(expected), actual: money(actual), difference: money(expected - actual) } });
      }
      if (!journalAccount.has(id) && actual !== 0n) issues.push({ code: 'SUPPLEMENT_EQUITY_ACCOUNT_EXTRA', account_id: id });
    }
    if (transfers !== 0n) issues.push({ code: 'SUPPLEMENT_EQUITY_TRANSFERS_UNBALANCED', detail: { total: money(transfers) } });
    if (ctx.retained_earnings_account_id && !openingBy.has(ctx.retained_earnings_account_id) && !equityAccounts.has(ctx.retained_earnings_account_id)) {
      issues.push({ code: 'SUPPLEMENT_RETAINED_EARNINGS_MISSING', account_id: ctx.retained_earnings_account_id });
    }
    const re = ctx.retained_earnings_account_id;
    const reDifference = re ? -(balance.get(re) ?? 0n) - ((openingBy.get(re) ?? 0n) + (movementBy.get(re) ?? 0n)) : 0n;
    Object.assign(totals, { opening: money(opening), movements: money(movements), closing: money(opening + movements), retained_earnings_difference: money(reDifference) });
  }
  return { valid: issues.length === 0, issues, totals };
}

/** sha256 over the cut-over journal's id and its lines (account, debit, credit), order-independent. */
export function ledgerFingerprint(journalId: string, lines: Pick<JournalLine, 'account_id' | 'debit' | 'credit'>[]): string {
  const canon = lines.map((l) => `${l.account_id}|${money(cents(l.debit))}|${money(cents(l.credit))}`).sort();
  return createHash('sha256').update(JSON.stringify([journalId, canon])).digest('hex');
}

type AuthorityRow = { id: string; status: string; from_date: string; to_date: string; cutover_journal_id: string | null; retained_earnings_account_id: string | null };

/** Loads everything the evaluation needs for one active range (journal lines, accounts, functional currency at D+1, foreign-currency cash links). */
export async function loadEvaluationContext(db: Queryable, companyId: string, authority: AuthorityRow): Promise<EvaluationContext & { fingerprint: string | null }> {
  const journal = authority.cutover_journal_id ? (await db.query<JournalLine>(
    `SELECT l.account_id,l.debit::text,l.credit::text,a.cash_role,a.cash_flow_category,a.statement_category FROM journal_lines l
     JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
     WHERE l.company_id=$1 AND j.id=$2 AND j.entry_type='cutover_balance' AND j.status='posted' ORDER BY l.sequence,l.id`, [companyId, authority.cutover_journal_id])).rows : [];
  const accounts = new Map((await db.query<AccountInfo>('SELECT id,cash_role,cash_flow_category,statement_category FROM accounts WHERE company_id=$1', [companyId])).rows.map((a) => [a.id, a]));
  const profiles = (await db.query<{ functional_currency: string }>(
    `SELECT functional_currency FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=($2::date+1) AND (effective_to IS NULL OR effective_to>=($2::date+1))`,
    [companyId, authority.to_date])).rows;
  const functional = profiles.length === 1 ? profiles[0]!.functional_currency : null;
  const cashIds = journal.filter((l) => l.cash_role !== 'non_cash').map((l) => l.account_id);
  const foreign = functional && cashIds.length ? (await db.query<{ account_id: string }>(
    `SELECT DISTINCT k.account_id FROM bank_account_ledger_links k JOIN bank_accounts b ON b.id=k.bank_account_id AND b.company_id=k.company_id
     WHERE k.company_id=$1 AND k.account_id=ANY($2::uuid[]) AND b.currency_code<>$3 AND k.valid_from<=$5::date AND (k.valid_to IS NULL OR k.valid_to>=$4::date)`,
    [companyId, cashIds, functional, authority.from_date, authority.to_date])).rows.map((r) => r.account_id) : [];
  return {
    journal, accounts, functional_currency: functional, foreign_cash_account_ids: foreign, retained_earnings_account_id: authority.retained_earnings_account_id,
    fingerprint: authority.cutover_journal_id && journal.length ? ledgerFingerprint(authority.cutover_journal_id, journal) : null,
  };
}

const VERSION_COLUMNS = `id,company_id,authority_id,kind,version_no,status,supersedes_id,source_system,evidence_reference,fx_translation_evidence,functional_currency,
  prepared_by,prepared_at,row_version,approved_by,approved_at,cutover_journal_id,ledger_fingerprint,superseded_by_id,superseded_at,voided_by,voided_at,void_reason`;
const LINE_COLUMNS = `line_type,account_id,section,movement_type,label,amount::text,opening_amount::text,closing_amount::text,classification_override_reason`;

async function loadAuthority(db: Queryable, companyId: string, authorityId: string, lock = false): Promise<AuthorityRow> {
  const row = (await db.query<AuthorityRow>(
    `SELECT id,status,from_date::text,to_date::text,cutover_journal_id,activation_snapshot->>'retained_earnings_account_id' retained_earnings_account_id
     FROM ledger_source_authority WHERE id=$1 AND company_id=$2${lock ? ' FOR SHARE' : ''}`, [authorityId, companyId])).rows[0];
  if (!row) throw new LedgerSourceAuthorityNotFoundError();
  return row;
}

async function loadLines(db: Queryable, companyId: string, versionId: string): Promise<SupplementLine[]> {
  return (await db.query<SupplementLine>(`SELECT ${LINE_COLUMNS} FROM cutover_supplement_lines WHERE company_id=$1 AND version_id=$2 ORDER BY line_no`, [companyId, versionId])).rows;
}

export type SupplementStatus = {
  kind: SupplementKind; state: 'complete' | 'missing' | 'invalid'; version_id: string | null; version_no: number | null; revision_pending: boolean;
  reasons: string[]; issues: SupplementIssue[]; totals: Record<string, string> | null; lines: SupplementLine[];
};

/**
 * Read-only, computed on every request (spec F): the approved supplement of each kind for a fiscal year's active cut-over range, re-evaluated
 * against the current cut-over journal. Returns null for a year without an active range (January-1 companies: no query beyond this one).
 */
export async function loadSupplementStatus(db: Queryable, companyId: string, fiscalYearId: string): Promise<Record<SupplementKind, SupplementStatus> | null> {
  const authority = (await db.query<AuthorityRow & { fy_start: string }>(
    `SELECT a.id,a.status,a.from_date::text,a.to_date::text,a.cutover_journal_id,a.activation_snapshot->>'retained_earnings_account_id' retained_earnings_account_id,f.start_date::text fy_start
     FROM ledger_source_authority a JOIN fiscal_years f ON f.company_id=a.company_id AND f.id=$2
     WHERE a.company_id=$1 AND a.status='active' AND a.from_date<=f.end_date AND a.to_date>=f.start_date ORDER BY a.from_date LIMIT 1`, [companyId, fiscalYearId])).rows[0];
  if (!authority) return null;
  const versions = (await db.query<SupplementVersion>(`SELECT ${VERSION_COLUMNS} FROM cutover_supplement_versions WHERE company_id=$1 AND authority_id=$2 AND status IN ('approved','draft')`, [companyId, authority.id])).rows;
  const ctx = await loadEvaluationContext(db, companyId, authority);
  const result = {} as Record<SupplementKind, SupplementStatus>;
  for (const kind of ['cash_flow', 'equity'] as const) {
    const approved = versions.find((v) => v.kind === kind && v.status === 'approved');
    const revision_pending = versions.some((v) => v.kind === kind && v.status === 'draft' && Boolean(approved));
    if (!approved) { result[kind] = { kind, state: 'missing', version_id: null, version_no: null, revision_pending: false, reasons: ['SUPPLEMENT_NOT_APPROVED'], issues: [], totals: null, lines: [] }; continue; }
    const lines = await loadLines(db, companyId, approved.id);
    const evaluation = evaluateSupplement(kind, approved, lines, ctx);
    const reasons: string[] = [];
    if (authority.from_date !== authority.fy_start) reasons.push('CUTOVER_RANGE_NOT_FROM_YEAR_START');
    if (!ctx.fingerprint || approved.ledger_fingerprint !== ctx.fingerprint || approved.cutover_journal_id !== authority.cutover_journal_id) reasons.push('SUPPLEMENT_LEDGER_FINGERPRINT_CHANGED');
    for (const issue of evaluation.issues) if (!reasons.includes(issue.code)) reasons.push(issue.code);
    result[kind] = { kind, state: reasons.length ? 'invalid' : 'complete', version_id: approved.id, version_no: approved.version_no, revision_pending, reasons, issues: evaluation.issues, totals: evaluation.totals, lines };
  }
  return result;
}

const translate = (error: unknown): never => {
  if (error instanceof LedgerSourceAuthorityError || error instanceof LedgerSourceAuthorityNotFoundError) throw error;
  const e = error as { message?: string; code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'cutover_supplement_one_draft_uidx') throw new SupplementValidationError('SUPPLEMENT_DRAFT_EXISTS');
  if (e.code === '23505' && (e.constraint === 'cutover_supplement_one_approved_uidx' || e.constraint === 'cutover_supplement_versions_authority_id_kind_version_no_key')) throw new SupplementValidationError('SUPPLEMENT_CONCURRENT_CHANGE');
  if (e.message && ['SUPPLEMENT_IMMUTABLE', 'SUPPLEMENT_AUTHORITY_NOT_ACTIVE', 'SUPPLEMENT_STALE_WRITE'].includes(e.message)) throw new SupplementValidationError(e.message);
  throw error;
};

/** Writes: draft create / replace / void and approve (with supersession). Each one runs under the company's supplement lock in one transaction with its audit event. */
export class CutoverSupplementService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  async list(companyId: string, authorityId: string) {
    const authority = await loadAuthority(this.db, companyId, authorityId);
    const versions = (await this.db.query<SupplementVersion>(`SELECT ${VERSION_COLUMNS} FROM cutover_supplement_versions WHERE company_id=$1 AND authority_id=$2 ORDER BY kind,version_no`, [companyId, authorityId])).rows;
    if (authority.status !== 'active') return { authority_id: authorityId, versions: versions.map((v) => ({ ...v, lines: [] as SupplementLine[], evaluation: null })) };
    const ctx = await loadEvaluationContext(this.db, companyId, authority);
    const out = [];
    for (const v of versions) {
      const lines = await loadLines(this.db, companyId, v.id);
      out.push({ ...v, lines, evaluation: v.status === 'draft' || v.status === 'approved' ? evaluateSupplement(v.kind, v, lines, ctx) : null });
    }
    return { authority_id: authorityId, functional_currency: ctx.functional_currency, versions: out };
  }

  async kindOf(companyId: string, authorityId: string, versionId: string): Promise<SupplementKind> {
    const row = (await this.db.query<{ kind: SupplementKind }>('SELECT kind FROM cutover_supplement_versions WHERE id=$1 AND company_id=$2 AND authority_id=$3', [versionId, companyId, authorityId])).rows[0];
    if (!row) throw new LedgerSourceAuthorityNotFoundError();
    return row.kind;
  }

  private async tx<T>(companyId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`cutover-supplement:${companyId}`]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return translate(error);
    } finally {
      client.release();
    }
  }

  private async insertLines(c: PoolClient, companyId: string, versionId: string, lines: SupplementLine[], accounts: Map<string, unknown>) {
    // Tenant isolation: every referenced account must belong to this company (the composite FK enforces it again in the database).
    const foreign = lines.find((l) => l.account_id && !accounts.has(l.account_id));
    if (foreign) throw new SupplementValidationError('SUPPLEMENT_ACCOUNT_NOT_FOUND', { account_id: foreign.account_id });
    let n = 1;
    for (const l of lines) {
      await c.query(`INSERT INTO cutover_supplement_lines(company_id,version_id,line_no,${LINE_COLUMNS.replace(/::text/g, '')}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [companyId, versionId, n++, l.line_type, l.account_id, l.section, l.movement_type, l.label, l.amount, l.opening_amount, l.closing_amount, l.classification_override_reason]);
    }
  }

  private async lockVersion(c: PoolClient, companyId: string, authorityId: string, versionId: string, expected: number) {
    const v = (await c.query<SupplementVersion>(`SELECT ${VERSION_COLUMNS} FROM cutover_supplement_versions WHERE id=$1 AND company_id=$2 AND authority_id=$3 FOR UPDATE`, [versionId, companyId, authorityId])).rows[0];
    if (!v) throw new LedgerSourceAuthorityNotFoundError();
    if (v.status !== 'draft') throw new SupplementValidationError('SUPPLEMENT_NOT_DRAFT');
    if (v.row_version !== expected) throw new SupplementValidationError('SUPPLEMENT_STALE_WRITE', { current_row_version: v.row_version });
    return v;
  }

  async createDraft(companyId: string, actor: string, authorityId: string, kind: SupplementKind, input: SupplementInput) {
    return this.tx(companyId, async (c) => {
      const authority = await loadAuthority(c, companyId, authorityId, true);
      if (authority.status !== 'active') throw new SupplementValidationError('SUPPLEMENT_AUTHORITY_NOT_ACTIVE');
      const ctx = await loadEvaluationContext(c, companyId, authority);
      if (!ctx.functional_currency) throw new SupplementValidationError('SUPPLEMENT_FUNCTIONAL_CURRENCY_UNKNOWN');
      const approved = (await c.query<{ id: string }>(`SELECT id FROM cutover_supplement_versions WHERE company_id=$1 AND authority_id=$2 AND kind=$3 AND status='approved'`, [companyId, authorityId, kind])).rows[0];
      const next = Number((await c.query<{ n: string }>('SELECT (COALESCE(MAX(version_no),0)+1)::text n FROM cutover_supplement_versions WHERE authority_id=$1 AND kind=$2', [authorityId, kind])).rows[0]!.n);
      const v = (await c.query<SupplementVersion>(
        `INSERT INTO cutover_supplement_versions(company_id,authority_id,kind,version_no,supersedes_id,source_system,evidence_reference,fx_translation_evidence,functional_currency,prepared_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${VERSION_COLUMNS}`,
        [companyId, authorityId, kind, next, approved?.id ?? null, input.source_system, input.evidence_reference, input.fx_translation_evidence, ctx.functional_currency, actor])).rows[0]!;
      await this.insertLines(c, companyId, v.id, input.lines, ctx.accounts);
      const evaluation = evaluateSupplement(kind, v, input.lines, ctx);
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'cutover_supplement.draft_create', entity_type: 'cutover_supplement_version', entity_id: v.id,
        before_data: null, after_data: { authority_id: authorityId, kind, version_no: next, supersedes_id: v.supersedes_id, source_system: v.source_system, evidence_reference: v.evidence_reference, line_count: input.lines.length, totals: evaluation.totals, overrides: overrides(input.lines) },
      }, c);
      return { version: { ...v, lines: input.lines }, evaluation };
    });
  }

  async replaceDraft(companyId: string, actor: string, authorityId: string, versionId: string, expected: number, input: SupplementInput) {
    return this.tx(companyId, async (c) => {
      const authority = await loadAuthority(c, companyId, authorityId, true);
      const old = await this.lockVersion(c, companyId, authorityId, versionId, expected);
      const parsed = input.lines.every((l) => LINE_TYPES[old.kind].includes(l.line_type));
      if (!parsed) throw new SupplementValidationError('SUPPLEMENT_LINES_INVALID');
      const before = await loadLines(c, companyId, versionId);
      const ctx = await loadEvaluationContext(c, companyId, authority);
      const beforeEval = evaluateSupplement(old.kind, old, before, ctx);
      await c.query('DELETE FROM cutover_supplement_lines WHERE company_id=$1 AND version_id=$2', [companyId, versionId]);
      await this.insertLines(c, companyId, versionId, input.lines, ctx.accounts);
      const v = (await c.query<SupplementVersion>(
        `UPDATE cutover_supplement_versions SET source_system=$3,evidence_reference=$4,fx_translation_evidence=$5,row_version=row_version+1 WHERE id=$1 AND company_id=$2 AND status='draft' RETURNING ${VERSION_COLUMNS}`,
        [versionId, companyId, input.source_system, input.evidence_reference, input.fx_translation_evidence])).rows[0]!;
      const evaluation = evaluateSupplement(v.kind, v, input.lines, ctx);
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'cutover_supplement.draft_update', entity_type: 'cutover_supplement_version', entity_id: v.id,
        // The draft's lines are replaced as a whole, so the audit keeps both complete line sets (the only record of the previous draft content).
        before_data: { row_version: old.row_version, source_system: old.source_system, evidence_reference: old.evidence_reference, fx_translation_evidence: old.fx_translation_evidence, line_count: before.length, totals: beforeEval.totals, overrides: overrides(before), lines: before },
        after_data: { row_version: v.row_version, source_system: v.source_system, evidence_reference: v.evidence_reference, fx_translation_evidence: v.fx_translation_evidence, line_count: input.lines.length, totals: evaluation.totals, overrides: overrides(input.lines), lines: input.lines },
      }, c);
      return { version: { ...v, lines: input.lines }, evaluation };
    });
  }

  async voidDraft(companyId: string, actor: string, authorityId: string, versionId: string, expected: number, reason: string) {
    return this.tx(companyId, async (c) => {
      await this.lockVersion(c, companyId, authorityId, versionId, expected);
      const v = (await c.query<SupplementVersion>(
        `UPDATE cutover_supplement_versions SET status='voided',voided_by=$3,voided_at=NOW(),void_reason=$4,row_version=row_version+1 WHERE id=$1 AND company_id=$2 AND status='draft' RETURNING ${VERSION_COLUMNS}`,
        [versionId, companyId, actor, reason])).rows[0]!;
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'cutover_supplement.draft_void', entity_type: 'cutover_supplement_version', entity_id: v.id,
        before_data: { status: 'draft' }, after_data: { status: 'voided', kind: v.kind, version_no: v.version_no }, reason,
      }, c);
      return { version: v };
    });
  }

  /** Approval: every invariant must hold now; the previous approved version (if any) becomes superseded in the same transaction. */
  async approve(companyId: string, actor: string, authorityId: string, versionId: string, expected: number) {
    return this.tx(companyId, async (c) => {
      const authority = await loadAuthority(c, companyId, authorityId, true);
      if (authority.status !== 'active') throw new SupplementValidationError('SUPPLEMENT_AUTHORITY_NOT_ACTIVE');
      const v = await this.lockVersion(c, companyId, authorityId, versionId, expected);
      const lines = await loadLines(c, companyId, versionId);
      const ctx = await loadEvaluationContext(c, companyId, authority);
      const evaluation = evaluateSupplement(v.kind, v, lines, ctx);
      if (!lines.length) evaluation.issues.push({ code: 'SUPPLEMENT_LINES_REQUIRED' });
      if (!ctx.fingerprint) evaluation.issues.push({ code: 'SUPPLEMENT_CUTOVER_JOURNAL_MISSING' });
      if (evaluation.issues.length) throw new SupplementValidationError('SUPPLEMENT_INVARIANTS_FAILED', { issues: evaluation.issues, totals: evaluation.totals });
      const previous = (await c.query<{ id: string; version_no: number }>(
        `SELECT id,version_no FROM cutover_supplement_versions WHERE company_id=$1 AND authority_id=$2 AND kind=$3 AND status='approved' FOR UPDATE`, [companyId, authorityId, v.kind])).rows[0];
      if ((previous?.id ?? null) !== v.supersedes_id) throw new SupplementValidationError('SUPPLEMENT_CONCURRENT_CHANGE');
      if (previous) {
        await c.query(`UPDATE cutover_supplement_versions SET status='superseded',superseded_by_id=$3,superseded_at=NOW() WHERE id=$1 AND company_id=$2 AND status='approved'`, [previous.id, companyId, v.id]);
        await this.audit.logEvent({
          company_id: companyId, actor_user_id: actor, action: 'cutover_supplement.superseded', entity_type: 'cutover_supplement_version', entity_id: previous.id,
          before_data: { status: 'approved', version_no: previous.version_no }, after_data: { status: 'superseded', superseded_by_id: v.id, superseded_by_version_no: v.version_no },
        }, c);
      }
      const snapshot = { totals: evaluation.totals, line_count: lines.length, functional_currency: ctx.functional_currency, foreign_cash_account_ids: ctx.foreign_cash_account_ids, overrides: overrides(lines) };
      const approved = (await c.query<SupplementVersion>(
        `UPDATE cutover_supplement_versions SET status='approved',approved_by=$3,approved_at=NOW(),cutover_journal_id=$4,ledger_fingerprint=$5,approval_snapshot=$6::jsonb,row_version=row_version+1
         WHERE id=$1 AND company_id=$2 AND status='draft' RETURNING ${VERSION_COLUMNS}`,
        [v.id, companyId, actor, authority.cutover_journal_id, ctx.fingerprint, JSON.stringify(snapshot)])).rows[0]!;
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'cutover_supplement.approve', entity_type: 'cutover_supplement_version', entity_id: v.id,
        before_data: { status: 'draft', row_version: v.row_version },
        after_data: { status: 'approved', kind: v.kind, version_no: v.version_no, supersedes_id: v.supersedes_id, prepared_by: v.prepared_by, cutover_journal_id: authority.cutover_journal_id, ledger_fingerprint: ctx.fingerprint, ...snapshot },
      }, c);
      return { version: { ...approved, lines }, evaluation };
    });
  }
}

/** C4 exceptions, kept in audit evidence verbatim (the account classification itself is never changed). */
const overrides = (lines: SupplementLine[]) => lines.flatMap((l, i) => (l.classification_override_reason ? [{ line_no: i + 1, account_id: l.account_id, section: l.section, reason: l.classification_override_reason }] : []));
