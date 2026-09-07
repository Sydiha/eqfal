import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const foundation=readFileSync(new URL('../migrations/026_opening_balance_review.sql',import.meta.url),'utf8');
const corrective=readFileSync(new URL('../migrations/027_opening_balance_traceability_correction.sql',import.meta.url),'utf8');

describe('Phase 1C opening balance migrations',()=>{
  it('adds the four dedicated capabilities',()=>{
    for(const capability of ['opening_balance.view','opening_balance.manage','opening_balance.review','opening_balance.approve']) expect(foundation).toContain(`('${capability}')`);
  });

  it('creates one tenant-scoped review per fiscal year with the approved lifecycle',()=>{
    expect(foundation).toContain('CREATE TABLE opening_balance_reviews');
    expect(foundation).toContain("status IN ('draft','in_review','approved')");
    expect(foundation).toContain('UNIQUE(company_id,fiscal_year_id)');
    expect(foundation).toContain('FOREIGN KEY(fiscal_year_id,company_id) REFERENCES fiscal_years(id,company_id)');
    expect(foundation).toContain('FOREIGN KEY(journal_entry_id,company_id) REFERENCES journal_entries(id,company_id)');
  });

  it('creates tenant-scoped evidence items with source, confidence and optimistic versioning',()=>{
    expect(foundation).toContain('CREATE TABLE opening_balance_items');
    expect(foundation).toContain("balance_side IN ('debit','credit')");
    expect(foundation).toContain("confidence IN ('high','medium','low')");
    expect(foundation).toContain('version INTEGER NOT NULL DEFAULT 1');
    for(const relation of ['accounts','counterparties','partners','bank_accounts','fixed_assets','documents']) expect(foundation).toContain(`REFERENCES ${relation}(id,company_id)`);
  });

  it('extends the category set to inventory without rewriting the applied foundation migration',()=>{
    expect(foundation).not.toContain("'inventory'");
    expect(corrective).toContain('DROP CONSTRAINT opening_balance_items_category_check');
    expect(corrective).toContain("'inventory'");
  });

  it('adds tenant-safe obligation and custody traceability',()=>{
    expect(corrective).toContain('ADD COLUMN obligation_id UUID');
    expect(corrective).toContain('ADD COLUMN custody_id UUID');
    expect(corrective).toContain('REFERENCES obligations(id, company_id)');
    expect(corrective).toContain('REFERENCES custody_advances(id, company_id)');
  });
});
