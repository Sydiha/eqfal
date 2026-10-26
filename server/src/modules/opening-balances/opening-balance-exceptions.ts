import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import {
  evaluateOpeningReconciliation, loadOpeningReconciliationInput,
  type ReconciliationInput, type ReconciliationIssue, type ReconciliationReport,
} from './opening-balance-reconciliation';

// C4-P2b-1: auditable acceptance of incomplete evidence on an opening balance review (migration 097).
// An exception never changes the reconciliation classification, an item, a journal or an amount. It records that a named user, with a
// written reason, accepted one `incomplete_evidence` issue while the review was in_review. Approval requires a valid, current acceptance
// for every remaining incomplete issue; blocked and mismatch issues are never acceptable. Identity and freshness are computed here, on
// the server, from the same evidence snapshot the reconciliation used.

export const OB_EXCEPTION_ACCEPT_CAPABILITY = 'opening_balance.exception.accept';
export const OB_EXCEPTIONS_REQUIRED_CODE = 'OPENING_BALANCE_EXCEPTIONS_REQUIRED';
export const OB_EXCEPTION_DISCLOSURE = 'Accepted — not verified.';
export const OB_EXCEPTION_ELIGIBLE_CODES: readonly string[] = [
  'OB_BANK_AGGREGATE_ONLY', 'OB_REFERENCE_MISSING', 'OB_BANK_EVIDENCE_MISSING', 'OB_BANK_CURRENCY_NOT_COMPARABLE',
  'OB_FUNCTIONAL_CURRENCY_UNKNOWN', 'OB_CONTROL_ACCOUNT_UNMAPPED', 'OB_SUBLEDGER_AGGREGATE_ONLY',
  'OB_SUBLEDGER_UNLINKED_OBLIGATION', 'OB_SUBLEDGER_TOTAL_DIFFERENCE',
];
const TOTAL_DIFFERENCE = 'OB_SUBLEDGER_TOTAL_DIFFERENCE';
export const OB_EXCEPTION_REASON_MIN = 10;
export const OB_EXCEPTION_REASON_MAX = 1000;
/** Detail keys that name WHICH issue it is (everything else in `detail` is a measured value and belongs to the fingerprint only). */
const IDENTITY_DETAIL_KEYS = ['reference', 'obligation_id'] as const;

export class OpeningBalanceExceptionError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}

/** At least 10 characters that are not whitespace (JS `\s` is a superset of the database `\s`, so the CHECK never rejects what passes here). */
export const reasonIsMeaningful = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= OB_EXCEPTION_REASON_MAX && v.replace(/\s/g, '').length >= OB_EXCEPTION_REASON_MIN;

const sha = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export type EvaluatedIssue = ReconciliationIssue & { issue_key: string; evidence_fingerprint: string; item_version: number | null };
export type EvidenceEvaluation = { report: ReconciliationReport; issues: EvaluatedIssue[] };

type ItemEvidence = { id: string; version: number; [k: string]: unknown };

/** Reconciles the review and attaches a server-computed identity and evidence fingerprint to every issue. Reads only. */
export async function evaluateOpeningEvidence(client: PoolClient, companyId: string, reviewId: string, startDate: string, lock = false): Promise<EvidenceEvaluation> {
  const input = await loadOpeningReconciliationInput(client, companyId, reviewId, startDate, lock);
  const report = evaluateOpeningReconciliation(input);
  const rows = (await client.query<ItemEvidence>(
    `SELECT id,version,category,account_id,amount::text,balance_side,counterparty_id,partner_id,bank_account_id,asset_id,obligation_id,custody_id,
            source_type,source_document_id,source_reference,confidence,note
       FROM opening_balance_items WHERE company_id=$1 AND review_id=$2`, [companyId, reviewId])).rows;
  const docIds = [...new Set(rows.map((r) => r['source_document_id']).filter((x): x is string => typeof x === 'string'))];
  const docs = new Map((await client.query<{ id: string; sha256: string; storage_key: string }>(
    `SELECT id,sha256,storage_key FROM documents WHERE company_id=$1 AND id=ANY($2::uuid[])${lock ? ' FOR SHARE' : ''}`, [companyId, docIds])).rows.map((d) => [d.id, d]));
  const itemById = new Map(rows.map((r) => [r.id, r]));
  const issues = report.issues.map((issue) => {
    const item = issue.item_id ? itemById.get(issue.item_id) : undefined;
    const identity: Record<string, string> = {};
    for (const k of IDENTITY_DETAIL_KEYS) if (issue.detail?.[k] !== undefined) identity[k] = issue.detail[k]!;
    const issue_key = sha({ review: reviewId, code: issue.code, section: issue.section, item: issue.item_id ?? null, identity });
    const evidence_fingerprint = sha({
      issue, start: input.startDate, functional_currency: input.functionalCurrency,
      item: item ?? null, document: item?.['source_document_id'] ? docs.get(item['source_document_id'] as string) ?? 'missing' : null,
      context: issueContext(input, issue, item),
    });
    return { ...issue, issue_key, evidence_fingerprint, item_version: item ? item.version : null };
  });
  return { report, issues };
}

/** The reference evidence one issue depends on: bank link/statement/currency, obligations, control mapping, or the section population. */
function issueContext(input: ReconciliationInput, issue: ReconciliationIssue, item: ItemEvidence | undefined) {
  const obligation = (id: string | null | undefined) => (id ? input.referencedObligations.get(id) ?? input.openingObligations.find((o) => o.id === id) ?? null : null);
  const control = (section: string) => { const s = input.controlAccounts.get(section as 'receivable' | 'payable'); return s ? [...s].sort() : null; };
  if (issue.code === TOTAL_DIFFERENCE) {
    return {
      items: input.items.filter((i) => i.category === issue.section).map((i) => ({ id: i.id, amount: i.amount, side: i.balance_side, obligation: i.obligation_id })).sort((a, b) => a.id.localeCompare(b.id)),
      obligations: input.openingObligations.filter((o) => o.direction === issue.section).map((o) => ({ id: o.id, amount: o.original_amount, cp: o.counterparty_id })).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  if (issue.section === 'bank') {
    const accountId = item?.['account_id'] as string | undefined;
    const bankIds = item?.['bank_account_id'] ? [item['bank_account_id'] as string] : [...new Set(input.bankLinksByAccount.get(accountId ?? '') ?? [])].sort();
    return bankIds.map((id) => ({
      id, bank: input.bankAccounts.get(id) ?? null, links: [...(input.bankLinks.get(id) ?? [])].sort(), statement: input.statements.get(id) ?? null,
    }));
  }
  return {
    control: control(issue.section),
    obligation: obligation(issue.detail?.['obligation_id'] ?? issue.detail?.['implied_obligation_id'] ?? (item?.['obligation_id'] as string | null | undefined)),
  };
}

export type ExceptionRow = {
  id: string; company_id: string; review_id: string; item_id: string | null; section: string; issue_code: string; issue_key: string;
  issue_snapshot: Record<string, unknown>; evidence_fingerprint: string; item_version: number | null; acknowledged_difference: string | null;
  reason: string; accepted_by: string; accepted_at: string; status: 'active' | 'superseded' | 'revoked';
  ended_by: string | null; ended_at: string | null; end_reason: string | null;
};
export type Acceptance = 'none' | 'accepted_unverified' | 'stale';

const SELECT_EXCEPTION = `SELECT id,company_id,review_id,item_id,section,issue_code,issue_key,issue_snapshot,evidence_fingerprint,item_version,acknowledged_difference,
  reason,accepted_by,accepted_at::text,status,ended_by,ended_at::text,end_reason FROM opening_balance_evidence_exceptions`;

export async function loadExceptions(client: PoolClient, companyId: string, reviewId: string): Promise<ExceptionRow[]> {
  return (await client.query<ExceptionRow>(`${SELECT_EXCEPTION} WHERE company_id=$1 AND review_id=$2 ORDER BY accepted_at,id`, [companyId, reviewId])).rows;
}

/** Acceptance state of each incomplete issue against the live acceptances (no writes). */
export function classifyAcceptance(evaluation: EvidenceEvaluation, exceptions: ExceptionRow[]) {
  const active = new Map(exceptions.filter((e) => e.status === 'active').map((e) => [e.issue_key, e]));
  return evaluation.issues.map((issue) => {
    const ex = active.get(issue.issue_key);
    const acceptance: Acceptance = !ex ? 'none' : ex.evidence_fingerprint === issue.evidence_fingerprint ? 'accepted_unverified' : 'stale';
    return { issue, acceptance, exception: ex ?? null };
  });
}

const actionable = (i: EvaluatedIssue) => ({
  issue_key: i.issue_key, code: i.code, class: i.class, section: i.section,
  ...(i.item_id ? { item_id: i.item_id } : {}), ...(i.detail ? { detail: i.detail } : {}),
});

/**
 * Approval protection. Throws unless every incomplete issue has an active acceptance with the CURRENT fingerprint. The caller has
 * already rejected blocking reports. Returns the accepted exceptions to record in the approval audit event.
 */
export function assertExceptionsCoverIncomplete(evaluation: EvidenceEvaluation, exceptions: ExceptionRow[]): ExceptionRow[] {
  const missing: ReturnType<typeof actionable>[] = [];
  const stale: ReturnType<typeof actionable>[] = [];
  const accepted: ExceptionRow[] = [];
  for (const { issue, acceptance, exception } of classifyAcceptance(evaluation, exceptions)) {
    if (issue.class !== 'incomplete_evidence') continue;
    if (acceptance === 'accepted_unverified' && OB_EXCEPTION_ELIGIBLE_CODES.includes(issue.code)) accepted.push(exception!);
    else if (acceptance === 'stale') stale.push(actionable(issue));
    else missing.push(actionable(issue));
  }
  if (missing.length || stale.length) {
    throw new OpeningBalanceExceptionError(
      stale.length ? 'OB_EXCEPTION_STALE' : OB_EXCEPTIONS_REQUIRED_CODE, 409,
      stale.length ? 'An accepted evidence exception is no longer current' : 'Every incomplete-evidence issue needs a recorded acceptance before approval',
      { missing, stale },
    );
  }
  return accepted;
}

export const exceptionAuditView = (e: ExceptionRow) => ({
  id: e.id, issue_key: e.issue_key, issue_code: e.issue_code, section: e.section, item_id: e.item_id, reason: e.reason,
  accepted_by: e.accepted_by, accepted_at: e.accepted_at, evidence_fingerprint: e.evidence_fingerprint,
  acknowledged_difference: e.acknowledged_difference, disclosure: OB_EXCEPTION_DISCLOSURE,
});

export type AcceptInput = { issueKey: string; evidenceFingerprint: string; reason: string; acknowledgedDifference: string | null };
type ReviewRef = { id: string; status: string };
const audit = new AuditLogRepository();

function requireInReview(review: ReviewRef) {
  if (review.status !== 'in_review') throw new OpeningBalanceExceptionError('OB_EXCEPTION_REVIEW_STATE', 409, 'Evidence exceptions can be changed only while the review is in review', { review_status: review.status });
}

/** Accepts the listed issues in the caller's transaction (all or nothing). The caller holds the review row FOR UPDATE. */
export async function acceptExceptions(client: PoolClient, companyId: string, review: ReviewRef, startDate: string, actor: string, entries: AcceptInput[]): Promise<ExceptionRow[]> {
  for (const e of entries) if (!reasonIsMeaningful(e.reason)) throw new OpeningBalanceExceptionError('OB_EXCEPTION_REASON_REQUIRED', 400, `A reason of at least ${OB_EXCEPTION_REASON_MIN} non-whitespace characters is required`, { issue_key: e.issueKey });
  requireInReview(review);
  const evaluation = await evaluateOpeningEvidence(client, companyId, review.id, startDate, true);
  const existing = await loadExceptions(client, companyId, review.id);
  const created: ExceptionRow[] = [];
  for (const e of entries) {
    const issue = evaluation.issues.find((i) => i.issue_key === e.issueKey);
    if (!issue) throw new OpeningBalanceExceptionError('OB_EXCEPTION_ISSUE_NOT_FOUND', 404, 'No such reconciliation issue on this review', { issue_key: e.issueKey });
    if (issue.class !== 'incomplete_evidence' || !OB_EXCEPTION_ELIGIBLE_CODES.includes(issue.code)) {
      throw new OpeningBalanceExceptionError('OB_EXCEPTION_NOT_ELIGIBLE', 409, 'Only incomplete-evidence issues can be accepted; blocked and mismatch findings never can', { issue: actionable(issue) });
    }
    if (issue.evidence_fingerprint !== e.evidenceFingerprint) {
      throw new OpeningBalanceExceptionError('OB_EXCEPTION_STALE', 409, 'The evidence changed since it was displayed', { issue: actionable(issue), evidence_fingerprint: issue.evidence_fingerprint });
    }
    if (issue.code === TOTAL_DIFFERENCE && e.acknowledgedDifference !== issue.detail?.['difference']) {
      throw new OpeningBalanceExceptionError('OB_EXCEPTION_DIFFERENCE_ACK_REQUIRED', 400, 'The displayed difference must be acknowledged exactly', { issue: actionable(issue), difference: issue.detail?.['difference'] ?? null });
    }
    if (issue.code !== TOTAL_DIFFERENCE && e.acknowledgedDifference !== null) {
      throw new OpeningBalanceExceptionError('OB_EXCEPTION_NOT_ELIGIBLE', 400, 'acknowledged_difference applies only to an aggregate total difference', { issue: actionable(issue) });
    }
    const live = existing.find((x) => x.status === 'active' && x.issue_key === issue.issue_key);
    if (live && live.evidence_fingerprint === issue.evidence_fingerprint) {
      throw new OpeningBalanceExceptionError('OB_EXCEPTION_ALREADY_ACTIVE', 409, 'This issue is already accepted', { issue: actionable(issue), exception_id: live.id });
    }
    if (live) await endException(client, companyId, live, 'superseded', actor, 'evidence_changed');
    let row: ExceptionRow;
    try {
      row = (await client.query<ExceptionRow>(
        `INSERT INTO opening_balance_evidence_exceptions(company_id,review_id,item_id,section,issue_code,issue_key,issue_snapshot,evidence_fingerprint,item_version,acknowledged_difference,reason,accepted_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id,company_id,review_id,item_id,section,issue_code,issue_key,issue_snapshot,evidence_fingerprint,item_version,acknowledged_difference,reason,accepted_by,accepted_at::text,status,ended_by,ended_at::text,end_reason`,
        [companyId, review.id, issue.item_id ?? null, issue.section, issue.code, issue.issue_key,
          JSON.stringify({ code: issue.code, class: issue.class, section: issue.section, ...(issue.item_id ? { item_id: issue.item_id } : {}), ...(issue.detail ? { detail: issue.detail } : {}) }),
          issue.evidence_fingerprint, issue.item_version, issue.code === TOTAL_DIFFERENCE ? e.acknowledgedDifference : null, e.reason.trim(), actor])).rows[0]!;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new OpeningBalanceExceptionError('OB_EXCEPTION_ALREADY_ACTIVE', 409, 'This issue is already accepted', { issue: actionable(issue) });
      throw err;
    }
    await audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'opening_balance.exception.accept', entity_type: 'opening_balance_evidence_exception', entity_id: row.id, before_data: null, after_data: { ...exceptionAuditView(row), issue_snapshot: row.issue_snapshot }, reason: row.reason }, client);
    created.push(row);
  }
  return created;
}

async function endException(client: PoolClient, companyId: string, row: ExceptionRow, status: 'superseded' | 'revoked', actor: string, reason: string): Promise<ExceptionRow> {
  const after = (await client.query<ExceptionRow>(
    `UPDATE opening_balance_evidence_exceptions SET status=$3,ended_by=$4,ended_at=NOW(),end_reason=$5 WHERE id=$1 AND company_id=$2 AND status='active'
     RETURNING id,company_id,review_id,item_id,section,issue_code,issue_key,issue_snapshot,evidence_fingerprint,item_version,acknowledged_difference,reason,accepted_by,accepted_at::text,status,ended_by,ended_at::text,end_reason`,
    [row.id, companyId, status, actor, reason])).rows[0];
  if (!after) throw new OpeningBalanceExceptionError('OB_EXCEPTION_NOT_ACTIVE', 409, 'The evidence exception is no longer active', { exception_id: row.id });
  await audit.logEvent({
    company_id: companyId, actor_user_id: actor, action: status === 'revoked' ? 'opening_balance.exception.revoke' : 'opening_balance.exception.supersede',
    entity_type: 'opening_balance_evidence_exception', entity_id: row.id, before_data: exceptionAuditView(row), after_data: { id: after.id, status: after.status, ended_at: after.ended_at, end_reason: after.end_reason }, reason,
  }, client);
  return after;
}

/** Explicit revocation of one active exception, with a written reason, while the review is in_review. */
export async function revokeException(client: PoolClient, companyId: string, review: ReviewRef, actor: string, exceptionId: string, reason: unknown): Promise<ExceptionRow> {
  if (!reasonIsMeaningful(reason)) throw new OpeningBalanceExceptionError('OB_EXCEPTION_REASON_REQUIRED', 400, `A reason of at least ${OB_EXCEPTION_REASON_MIN} non-whitespace characters is required`);
  requireInReview(review);
  const row = (await client.query<ExceptionRow>(`${SELECT_EXCEPTION} WHERE id=$1 AND company_id=$2 AND review_id=$3 FOR UPDATE`, [exceptionId, companyId, review.id])).rows[0];
  if (!row) throw new OpeningBalanceExceptionError('OB_EXCEPTION_NOT_FOUND', 404, 'Evidence exception not found');
  if (row.status !== 'active') throw new OpeningBalanceExceptionError('OB_EXCEPTION_NOT_ACTIVE', 409, 'The evidence exception is no longer active', { exception_id: row.id, status: row.status });
  return endException(client, companyId, row, 'revoked', actor, reason.trim());
}

/** Returning a review to draft ends every live acceptance (they are re-accepted after resubmission). */
export async function supersedeAllForDraftReturn(client: PoolClient, companyId: string, reviewId: string, actor: string): Promise<number> {
  const live = (await client.query<ExceptionRow>(`${SELECT_EXCEPTION} WHERE company_id=$1 AND review_id=$2 AND status='active' ORDER BY accepted_at,id FOR UPDATE`, [companyId, reviewId])).rows;
  for (const row of live) await endException(client, companyId, row, 'superseded', actor, 'review_returned_to_draft');
  return live.length;
}

/** Maps trigger and index failures of the exceptions table to stable API errors. */
export function mapExceptionDbError(e: unknown): OpeningBalanceExceptionError | null {
  const err = e as { code?: string; message?: string; constraint?: string };
  if (err?.code === '55000' && /evidence exception/i.test(err.message ?? '')) return new OpeningBalanceExceptionError('OB_EXCEPTION_IMMUTABLE', 409, 'Evidence exceptions are immutable in this state');
  if (err?.code === '23505' && err.constraint === 'opening_balance_exceptions_active_uidx') return new OpeningBalanceExceptionError('OB_EXCEPTION_ALREADY_ACTIVE', 409, 'This issue is already accepted');
  return null;
}
