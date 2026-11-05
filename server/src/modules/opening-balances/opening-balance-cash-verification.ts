import type { PoolClient } from 'pg';
import { evaluateOpeningEvidence, type EvidenceEvaluation } from './opening-balance-exceptions';
import { OB_CODES, type ReconciliationIssue, type ReconciliationStatus } from './opening-balance-reconciliation';
import config from '../../config';
import { getStorage } from '../../storage/storage.factory';
import { readVerified } from '../../storage/integrity';

export const CASH_VERIFY_CAPABILITY = 'opening_balance.evidence.verify';
export class CashVerificationError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export type CashDecision = {
  id: string; item_id: string; issue_key: string; evidence_fingerprint: string; item_version: number;
  evidence_reference: string; decision: 'verified' | 'rejected' | 'conflicting'; rationale: string;
  document_id: string | null; document_sha256: string | null; document_version: number | null;
  reviewed_by: string; reviewed_at: string;
};
export type CashDocument = { id: string; sha256: string; version: number; status: string; original_filename: string; mime_type: string; storage_key: string };
export async function inspectableCashDocument(client: PoolClient, companyId: string, documentId: string, lock = false): Promise<CashDocument | null> {
  const document = (await client.query<CashDocument>(
    `SELECT id,sha256,version,status,original_filename,mime_type,storage_key FROM documents WHERE id=$1 AND company_id=$2${lock ? ' FOR SHARE' : ''}`,
    [documentId, companyId])).rows[0];
  if (!document || document.status === 'rejected') return null;
  try { await readVerified(getStorage('documents', config.documentStorageDir), document.storage_key, document.sha256); return document; } catch { return null; }
}
const cashCode = OB_CODES.physicalCashEvidenceUserDeclared;
const rank: Record<ReconciliationStatus, number> = { verified: 0, incomplete_evidence: 1, mismatch: 2, blocked: 3 };

export async function cashDecisionState(client: PoolClient, companyId: string, reviewId: string, startDate: string, lock = false) {
  const evaluation = await evaluateOpeningEvidence(client, companyId, reviewId, startDate, lock);
  const decisions = (await client.query<CashDecision>(
    `SELECT id,item_id,issue_key,evidence_fingerprint,item_version,evidence_reference,decision,rationale,reviewed_by,reviewed_at,document_id,document_sha256,document_version
       FROM opening_balance_cash_verifications WHERE company_id=$1 AND review_id=$2
       ORDER BY reviewed_at DESC,id DESC${lock ? ' FOR SHARE' : ''}`, [companyId, reviewId])).rows;
  const review = (await client.query<{ submitted_at: string | null }>(
    'SELECT submitted_at FROM opening_balance_reviews WHERE company_id=$1 AND id=$2', [companyId, reviewId])).rows[0];
  const liveCash = new Set((await client.query<{ id: string }>(
    "SELECT id FROM opening_balance_items WHERE company_id=$1 AND review_id=$2 AND category='cash_on_hand'", [companyId, reviewId])).rows.map(i => i.id));
  const itemDocuments = new Map((await client.query<{ id: string; source_document_id: string | null }>(
    "SELECT id,source_document_id FROM opening_balance_items WHERE company_id=$1 AND review_id=$2 AND category='cash_on_hand'", [companyId, reviewId])).rows.map(i => [i.id, i.source_document_id]));
  const latest = new Map<string, CashDecision>();
  for (const d of decisions) if (!latest.has(d.item_id)) latest.set(d.item_id, d);
  const current = new Map(evaluation.issues.filter(i => i.code === cashCode && i.item_id).map(i => [i.item_id!, i]));
  const status = new Map<string, 'pending_verification' | 'reviewer_verified' | 'rejected' | 'conflicting' | 'stale'>();
  for (const i of evaluation.issues.filter(i => i.code === cashCode && i.item_id)) status.set(i.item_id!, 'pending_verification');
  for (const [itemId, d] of latest) {
    if (!liveCash.has(itemId)) continue;
    const i = current.get(itemId);
    const document = d.decision === 'verified' && d.document_id && itemDocuments.get(itemId) === d.document_id
      ? await inspectableCashDocument(client, companyId, d.document_id, lock) : null;
    const staleDocument = d.decision === 'verified' && (!document || document.sha256 !== d.document_sha256 || document.version !== d.document_version);
    status.set(itemId, !i || !review?.submitted_at || new Date(d.reviewed_at) < new Date(review.submitted_at) || i.issue_key !== d.issue_key || i.evidence_fingerprint !== d.evidence_fingerprint || i.item_version !== d.item_version || staleDocument
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
