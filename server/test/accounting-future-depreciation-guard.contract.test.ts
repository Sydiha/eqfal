import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sources = readFileSync(new URL('../src/modules/accounting/operational-sources.ts', import.meta.url), 'utf8');
const accounting = readFileSync(new URL('../src/modules/accounting/accounting.router.ts', import.meta.url), 'utf8');
const posting = readFileSync(new URL('../src/modules/accounting/journal-posting.ts', import.meta.url), 'utf8');

describe('future asset depreciation posting guard', () => {
  it('hides future depreciation from operational-source discovery', () => {
    expect(sources).toContain(
      "d.status='pending' AND d.period_end<=CURRENT_DATE AND a.status IN ('active','fully_depreciated')",
    );
  });

  it('applies the same due-date guard when an asset-depreciation source is loaded directly', () => {
    expect(sources).toContain(
      "WHERE d.id=$1 AND d.company_id=$2 AND d.status='pending' AND d.period_end<=CURRENT_DATE",
    );
  });

  it('protects journal creation and posting through the canonical operational-source lookup', () => {
    expect(accounting).toContain('operationalSourceQuery(type)');
    expect(posting).toContain('operationalSourceQuery(type as JournalOperationalSourceType)');
  });
});
