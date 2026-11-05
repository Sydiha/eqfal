import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const router = readFileSync(new URL('../src/modules/opening-balances/opening-balances.router.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/109_physical_cash_verification.sql', import.meta.url), 'utf8');

describe('physical cash verification boundaries', () => {
  it('requires a dedicated capability and a reviewer other than the preparer', () => {
    expect(router).toContain('requireCapability(CASH_VERIFY_CAPABILITY)');
    expect(router).toContain('capabilities.includes(CASH_VERIFY_CAPABILITY)');
    expect(router).toContain('review.prepared_by===actor');
  });
  it('checks the exact evidence again in the approval transaction', () => {
    expect(router).toContain('issue.evidence_fingerprint!==body.evidence_fingerprint');
    expect(router).toContain('cashDecisionState(c,companyId,review.id,year.start_date,true)');
    expect(router).toContain('applyCashDecisions(await cashDecisionState(c,companyId,review.id,year.start_date,true))');
  });
  it('adds an audit record and a forward-only decision table', () => {
    expect(router).toContain("action:'opening_balance.cash_evidence_decide'");
    expect(migration).toContain('CREATE TABLE opening_balance_cash_verifications');
    expect(migration).toContain('reviewed_at timestamptz NOT NULL DEFAULT now()');
    expect(migration).toContain('evidence_fingerprint text NOT NULL');
  });
});
