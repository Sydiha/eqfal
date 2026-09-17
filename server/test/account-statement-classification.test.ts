import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration=readFileSync(new URL('../migrations/033_account_statement_classification.sql',import.meta.url),'utf8');
const router=readFileSync(new URL('../src/modules/accounting/account-classification.router.ts',import.meta.url),'utf8');
const accountingRouter=readFileSync(new URL('../src/modules/accounting/accounting.router.ts',import.meta.url),'utf8');

describe('Phase 5A account statement classification',()=>{
  it('uses explicit non-null unmapped semantics',()=>{
    expect(migration).toContain("statement_category TEXT NOT NULL DEFAULT 'unmapped'");
    expect(migration).not.toMatch(/statement_category\s+TEXT\s+NULL/i);
    expect(router).toContain("'unmapped'");
    expect(router).toContain('statement_category=$2');
  });

  it('enforces the approved fail-closed category matrix in PostgreSQL',()=>{
    expect(migration).toContain("account_type = 'asset' AND statement_category IN ('unmapped','current_asset','non_current_asset')");
    expect(migration).toContain("account_type = 'liability' AND statement_category IN ('unmapped','current_liability','non_current_liability')");
    expect(migration).toContain("account_type = 'equity' AND statement_category IN ('unmapped','equity')");
    expect(migration).toContain("account_type = 'revenue' AND statement_category IN ('unmapped','revenue','finance_income','other_income')");
    expect(migration).toContain("account_type = 'expense' AND statement_category IN ('unmapped','cost_of_sales','operating_expense','finance_expense','other_expense')");
    expect(migration).toContain("NOT is_contra OR account_type = 'asset'");
  });

  it('keeps mapping tenant-scoped and queryable',()=>{
    expect(migration).toContain('ON accounts(company_id, statement_category, code, id)');
    expect(router).toContain("FROM accounts WHERE ${where} ORDER BY code,id");
    expect(router).toContain("let where='company_id=$1'");
    expect(router).toContain("WHERE id=$1 AND company_id=$2 FOR UPDATE");
    expect(router).toContain("WHERE id=$1 AND company_id=$2");
  });

  it('protects read/write capabilities and audits classification changes',()=>{
    expect(router).toContain("requireCapability('accounting.view')");
    expect(router).toContain("requireCapability('accounting.chart.edit')");
    expect(router).toContain('requireSameOrigin');
    expect(router).toContain("action:'account.classification.update'");
    expect(router).toContain('before_data:before');
    expect(router).toContain('after_data:after');
  });

  it('does not alter posted journals, trial balance, or general ledger logic',()=>{
    expect(migration).not.toMatch(/journal_entries|journal_lines|trial.balance|general.ledger/i);
    expect(router).not.toMatch(/journal_entries|journal_lines|trial.?balance|general.?ledger/i);
    expect(accountingRouter).toContain('async trialBalance(');
    expect(accountingRouter).toContain('async ledger(');
  });
});
