import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration=readFileSync(new URL('../migrations/034_cash_flow_classification.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/accounting/account-classification.router.ts',import.meta.url),'utf8');

describe('Phase 5D.1 cash-flow classification foundation',()=>{
  it('migrates existing accounts to deterministic conservative defaults',()=>{
    expect(migration).toContain("cash_role TEXT NOT NULL DEFAULT 'non_cash'");
    expect(migration).toContain("cash_flow_category TEXT NOT NULL DEFAULT 'unmapped'");
  });

  it('restricts persisted metadata to supported values',()=>{
    expect(migration).toContain("cash_role IN ('non_cash','cash','cash_equivalent')");
    expect(migration).toContain("cash_flow_category IN ('unmapped','operating','investing','financing')");
  });

  it('permits cash roles only on asset accounts',()=>{
    expect(migration).toContain("cash_role = 'non_cash' OR account_type = 'asset'");
    expect(router).toContain("cashRole==='non_cash'||accountType==='asset'");
  });

  it('keeps reads and writes company scoped',()=>{
    expect(router).toContain("let where='company_id=$1'");
    expect(router).toContain('WHERE id=$1 AND company_id=$2 FOR UPDATE');
    expect(router).toContain('WHERE id=$1 AND company_id=$2');
  });

  it('uses existing read and chart-management capabilities',()=>{
    expect(router).toContain("requireCapability('accounting.view')");
    expect(router).toContain("requireCapability('accounting.chart.edit')");
  });

  it('audits cash metadata atomically with before and after values',()=>{
    expect(router).toContain("action:'account.classification.update'");
    expect(router).toContain('before_data:before');
    expect(router).toContain('after_data:after');
    expect(router).toContain("cash_role=$5,cash_flow_category=$6");
  });

  it('does not alter journals or create cash-flow report persistence',()=>{
    expect(migration).not.toMatch(/journal_entries|journal_lines|cash_flow_statement/i);
    expect(router).not.toMatch(/journal_entries|journal_lines|cash.?flow.?statement/i);
  });
});
