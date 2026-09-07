import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration=readFileSync(new URL('../migrations/026_opening_balance_review.sql',import.meta.url),'utf8');

describe('Phase 1C opening balance migration',()=>{
  it('adds the four dedicated capabilities',()=>{
    for(const capability of ['opening_balance.view','opening_balance.manage','opening_balance.review','opening_balance.approve']) expect(migration).toContain(`('${capability}')`);
  });

  it('creates one tenant-scoped review per fiscal year with the approved lifecycle',()=>{
    expect(migration).toContain('CREATE TABLE opening_balance_reviews');
    expect(migration).toContain("status IN ('draft','in_review','approved')");
    expect(migration).toContain('UNIQUE(company_id,fiscal_year_id)');
    expect(migration).toContain('FOREIGN KEY(fiscal_year_id,company_id) REFERENCES fiscal_years(id,company_id)');
    expect(migration).toContain('FOREIGN KEY(journal_entry_id,company_id) REFERENCES journal_entries(id,company_id)');
  });

  it('creates tenant-scoped evidence items with source, confidence and optimistic versioning',()=>{
    expect(migration).toContain('CREATE TABLE opening_balance_items');
    expect(migration).toContain("balance_side IN ('debit','credit')");
    expect(migration).toContain("confidence IN ('high','medium','low')");
    expect(migration).toContain('version INTEGER NOT NULL DEFAULT 1');
    for(const relation of ['accounts','counterparties','partners','bank_accounts','fixed_assets','documents']) expect(migration).toContain(`REFERENCES ${relation}(id,company_id)`);
  });

  it('keeps the approved category set explicit and does not introduce inventory',()=>{
    for(const category of ['bank','receivable','payable','partner_capital','partner_current','partner_loan','custody_advance','vat_tax','fixed_asset_cost','accumulated_depreciation','other_asset','other_liability','equity']) expect(migration).toContain(`'${category}'`);
    expect(migration).not.toContain("'inventory'");
  });
});
