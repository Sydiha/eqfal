import type { PoolClient } from 'pg';
import { evaluateOpeningEvidence, type EvidenceEvaluation } from './opening-balance-exceptions';
import { OB_CODES, type ReconciliationIssue, type ReconciliationStatus } from './opening-balance-reconciliation';

export const CASH_VERIFY_CAPABILITY = 'opening_balance.evidence.verify';
export class CashVerificationError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export type CashDecision = {
  id: string; item_id: string; issue_key: string; evidence_fingerprint: string; item_version: number;
  evidence_reference: string; decision: 'verified' | 'rejected' | 'conflicting'; rationale: string;
  reviewed_by: string; reviewed_at: string;
};
const cashCode = OB_CODES.physicalCashEvidenceUserDeclared;
const rank: Record<ReconciliationStatus, number> = { verified: 0, incomplete_evidence: 1, mismatch: 2, blocked: 3 };

export async function cashDecisionState(client: PoolClient, companyId: string, reviewId: string, startDate: string, lock = false) {
  const evaluation = await evaluateOpeningEvidence(client, companyId, reviewId, startDate, lock);
  const decisions = (await client.query<CashDecision>(
    `SELECT id,item_id,issue_key,evidence_fingerprint,item_version,evidence_reference,decision,rationale,reviewed_by,reviewed_at
       FROM opening_balance_cash_verifications WHERE company_id=$1 AND review_id=$2
       ORDER BY reviewed_at DESC,id DESC${lock ? ' FOR SHARE' : ''}`, [companyId, reviewId])).rows;
  const review = (await client.query<{ submitted_at: string | null }>(
    'SELECT submitted_at FROM opening_balance_reviews WHERE company_id=$1 AND id=$2', [companyId, reviewId])).rows[0];
  const liveCash = new Set((await client.query<{ id: string }>(
    "SELECT id FROM opening_balance_items WHERE company_id=$1 AND review_id=$2 AND category='cash_on_hand'", [companyId, reviewId])).rows.map(i => i.id));
  const latest = new Map<string, CashDecision>();
  for (const d of decisions) if (!latest.has(d.item_id)) latest.set(d.item_id, d);
  const current = new Map(evaluation.issues.filter(i => i.code === cashCode && i.item_id).map(i => [i.item_id!, i]));
  const status = new Map<string, 'pending_verification' | 'reviewer_verified' | 'rejected' | 'conflicting' | 'stale'>();
  for (const i of evaluation.issues.filter(i => i.code === cashCode && i.item_id)) status.set(i.item_id!, 'pending_verification');
  for (const [itemId, d] of latest) {
    if (!liveCash.has(itemId)) continue;
    const i = current.get(itemId);
    status.set(itemId, !i || !review?.submitted_at || new Date(d.reviewed_at) < new Date(review.submitted_at) || i.issue_key !== d.issue_key || i.evidence_fingerprint !== d.evidence_fingerprint || i.item_version !== d.item_version
      ? 'stale' : d.decision === 'verified' ? 'reviewer_verified' : d.decision);
  }
  return { evaluation, decisions, latest, status, current };
}

export function applyCashDecisions(state: Awaited<ReturnType<typeof cashDecisionState>>): EvidenceEvaluation {
  const issues = state.evaluation.issues.filter(i => !(i.code === cashCode && i.item_id && state.status.get(i.item_id) === 'reviewer_verified'));
  const blocking: ReconciliationIssue[] = [];
  for (const [itemId, decision] of state.status) if (decision === 'rejected' || decision === 'conflicting' || decision === 'stale') {
    blocking.push({ code: decision === 'stale' ? 'OB_PHYSICAL_CASH_VERIFICATION_STALE' : decision === 'rejected' ? 'OB_PHYSICAL_CASH_EVIDENCE_REJECTED' : 'OB_PHYSICAL_CASH_EVIDENCE_CONFLICTING', class: 'blocked', section: 'cash_on_hand', item_id: itemId });
  }
  const reportIssues = [...issues, ...blocking];
  const sections = { ...state.evaluation.report.sections };
  sections.cash_on_hand = { ...sections.cash_on_hand,
    status: reportIssues.filter(i => i.section === 'cash_on_hand').reduce<ReconciliationStatus>((s, i) => rank[i.class] > rank[s] ? i.class : s, 'verified') };
  const status = Object.values(sections).reduce<ReconciliationStatus>((s, section) => rank[section.status] > rank[s] ? section.status : s, 'verified');
  return { issues, report: { ...state.evaluation.report, issues: reportIssues, sections, status, blocking: status === 'blocked' || status === 'mismatch' } };
}
