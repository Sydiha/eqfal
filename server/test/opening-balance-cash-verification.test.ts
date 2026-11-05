import { describe, expect, it } from 'vitest';
import { applyCashDecisions } from '../src/modules/opening-balances/opening-balance-cash-verification';
import type { EvidenceEvaluation } from '../src/modules/opening-balances/opening-balance-exceptions';

const issue = { code: 'OB_PHYSICAL_CASH_EVIDENCE_USER_DECLARED', class: 'incomplete_evidence' as const, section: 'cash_on_hand' as const, item_id: 'cash-1', issue_key: 'key', evidence_fingerprint: 'fingerprint', item_version: 1 };
const evaluation: EvidenceEvaluation = {
  issues: [issue], report: { status: 'incomplete_evidence', blocking: false, as_of_date: '2026-01-01', issues: [issue], sections: {
    cash_on_hand: { status: 'incomplete_evidence', item_count: 1, gl_total: '100.00', subledger_total: null },
    bank: { status: 'verified', item_count: 0, gl_total: '0.00', subledger_total: null },
    receivable: { status: 'verified', item_count: 0, gl_total: '0.00', subledger_total: '0.00' },
    payable: { status: 'verified', item_count: 0, gl_total: '0.00', subledger_total: '0.00' },
  } },
};
const state = (status: 'pending_verification' | 'reviewer_verified' | 'rejected' | 'conflicting' | 'stale') => ({ evaluation, status: new Map([['cash-1', status]]) } as Parameters<typeof applyCashDecisions>[0]);

describe('physical cash verification approval gate', () => {
  it('keeps an uploaded, high confidence reference pending until a reviewer decides', () => {
    expect(applyCashDecisions(state('pending_verification')).issues).toEqual([issue]);
  });
  it('clears only the physical cash incomplete finding after current verification', () => {
    const result = applyCashDecisions(state('reviewer_verified'));
    expect(result.issues).toEqual([]);
    expect(result.report.sections.cash_on_hand.status).toBe('verified');
  });
  it.each(['rejected', 'conflicting', 'stale'] as const)('blocks approval on %s evidence', status => {
    const result = applyCashDecisions(state(status));
    expect(result.report.blocking).toBe(true);
    expect(result.report.issues).toContainEqual(expect.objectContaining({ class: 'blocked', item_id: 'cash-1' }));
  });
});
