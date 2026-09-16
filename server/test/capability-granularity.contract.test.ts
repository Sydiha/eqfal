import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const fiscalRouter = readFileSync(new URL('../src/modules/fiscal-years/fiscal-year.router.ts', import.meta.url), 'utf8');
const monthlyRouter = readFileSync(new URL('../src/modules/monthly-close/monthly-close.router.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/039_capability_granularity.sql', import.meta.url), 'utf8');

describe('Phase 9A.2 capability granularity contract', () => {
  it('seeds action-specific fiscal-year and monthly-close capabilities', () => {
    for (const capability of [
      'fiscal_year.create',
      'fiscal_year.edit',
      'fiscal_year.close',
      'monthly_close.view',
      'monthly_close.create',
    ]) {
      expect(migration).toContain(`'${capability}'`);
    }
  });

  it('backfills existing broad grants so the migration is non-breaking', () => {
    expect(migration).toContain("WHERE rc.capability_id = 'fiscal_year.manage'");
    expect(migration).toContain("WHERE rc.capability_id = 'fiscal_year.view'");
    expect(migration).toContain("WHERE rc.capability_id = 'monthly_close.close'");
  });

  it('uses distinct fiscal-year mutation capabilities at the backend boundary', () => {
    expect(fiscalRouter).toContain('requireCapability(CREATE_CAPABILITY)');
    expect(fiscalRouter).toContain('requireCapability(EDIT_CAPABILITY)');
    expect(fiscalRouter).toContain('requireCapability(CLOSE_CAPABILITY)');
    expect(fiscalRouter).not.toContain('fiscal_year.manage');
  });

  it('does not couple monthly-close visibility or period creation to unrelated actions', () => {
    expect(monthlyRouter).toContain("requireCapability('monthly_close.view')");
    expect(monthlyRouter).toContain("requireCapability('monthly_close.create')");
    expect(monthlyRouter).not.toContain('requireCapabilityOrLegacy');
    expect(monthlyRouter).toContain("requireCapability('monthly_close.close')");
    expect(monthlyRouter).toContain("requireCapability('monthly_close.reopen')");
  });
});
