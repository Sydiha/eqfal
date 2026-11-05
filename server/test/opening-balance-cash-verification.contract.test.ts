import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const router = readFileSync(new URL('../src/modules/opening-balances/opening-balances.router.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/109_physical_cash_verification.sql', import.meta.url), 'utf8');
const overrideMigration = readFileSync(new URL('../migrations/111_cash_verification_admin_override.sql', import.meta.url), 'utf8');

describe('physical cash verification boundaries', () => {
  it('requires a dedicated capability and gates self-review behind active global System Admin authority', () => {
    expect(router).toContain('requireCapability(CASH_VERIFY_CAPABILITY)');
    expect(router).toContain('capabilities.includes(CASH_VERIFY_CAPABILITY)');
    expect(router).toContain("review.prepared_by===actor");
    expect(router).toContain('users WHERE id=$1 FOR SHARE');
    expect(overrideMigration).toContain('NEW.verification_type');
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
  it('stores a separate reason and immutable admin, preparer, evidence and decision identities', () => {
    expect(overrideMigration).toContain('verification_type');
    expect(overrideMigration).toContain('override_actor');
    expect(overrideMigration).toContain('override_preparer');
    expect(overrideMigration).toContain('override_reason');
    expect(overrideMigration).toContain('is_active AND is_system_admin');
    expect(overrideMigration).toContain('cash verification decisions are immutable');
  });
});
