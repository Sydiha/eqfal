import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source=readFileSync(new URL('../src/modules/opening-balances/opening-balances.router.ts',import.meta.url),'utf8');
const posting=readFileSync(new URL('../src/modules/accounting/journal-posting.ts',import.meta.url),'utf8');

describe('Phase 1C opening balance server contract',()=>{
  it('exposes only the approved tenant-scoped API boundary with distinct capabilities',()=>{
    for(const route of [
      "'/opening-balances/:fiscalYearId'",
      "'/opening-balances/:fiscalYearId/suggestions'",
      "'/opening-balances/:fiscalYearId/items'",
      "'/opening-balances/:fiscalYearId/items/:itemId'",
      "'/opening-balances/:fiscalYearId/submit-review'",
      "'/opening-balances/:fiscalYearId/return-to-draft'",
      "'/opening-balances/:fiscalYearId/approve'",
    ]) expect(source).toContain(route);
    expect(source).toContain('const base=[requireAuth,requireActiveCompany]');
    for(const capability of ['opening_balance.view','opening_balance.manage','opening_balance.review','opening_balance.approve']) expect(source).toContain(`requireCapability('${capability}')`);
  });

  it('enforces tenant ownership for fiscal year, review items and referenced entities',()=>{
    expect(source).toContain('WHERE id=$1 AND company_id=$2');
    expect(source).toContain('WHERE company_id=$1 AND fiscal_year_id=$2');
    expect(source).toContain('Referenced entity does not belong to the active company');
    for(const table of ['accounts','counterparties','partners','bank_accounts','fixed_assets','obligations','custody_advances','documents']) expect(source).toContain(`['${table}'`);
  });

  it('supports the complete approved category and traceability contract',()=>{
    expect(source).toContain("'inventory'");
    expect(source).toContain("'obligation_id','obligationId'");
    expect(source).toContain("'custody_id','custodyId'");
    expect(source).toContain('obligation_id,custody_id');
  });

  it('keeps item writes draft-only and protects against stale item updates',()=>{
    expect(source).toContain("review.status!=='draft'");
    expect(source).toContain('Items are editable only in draft');
    expect(source).toContain('Stale opening balance item');
    expect(source).toContain('version=version+1');
  });

  it('implements explicit review transitions and requires a reason when returning to draft',()=>{
    expect(source).toContain("to==='in_review'&&review.status!=='draft'");
    expect(source).toContain("to==='draft'&&review.status!=='in_review'");
    expect(source).toContain('Return reason is required');
    expect(source).toContain('review_note=$3');
    expect(source).toContain('parseReturnReason(req.body)');
  });

  it('delegates balance validation to one canonical opening journal at fiscal-year start',()=>{
    expect(source).toContain("'opening_balance','draft'");
    expect(source).toContain('year.start_date');
    expect(source).toContain('journal_entry_id');
    expect(source).toMatch(/postJournalInTransaction\(c,\s*companyId,\s*actor,\s*journal\.id\)/);
    expect(posting).toContain('Journal is not balanced');
    expect(posting).toContain('Opening balance date must equal fiscal year start');
  });

  it('nets opening items by account using PostgreSQL numeric arithmetic',()=>{
    expect(source).toContain("SUM(CASE WHEN i.balance_side='debit' THEN i.amount ELSE -i.amount END) net");
    expect(source).toContain('WHERE net<>0');
    expect(source).not.toContain("const k=`${x.account_id}:${x.balance_side}`");
  });

  it('reuses the canonical monthly-close guard and keeps approval atomic',()=>{
    expect(posting).toContain('assertAccountingDateWritable');
    expect(source).toContain("await c.query('BEGIN')");
    expect(source).toContain("await c.query('COMMIT')");
    expect(source).toContain("await c.query('ROLLBACK')");
    expect(source).toMatch(/postJournalInTransaction\(c,\s*companyId,\s*actor,\s*journal\.id\)/);
  });

  it('keeps suggestions advisory, sequential on one client and avoids inferred partner balances',()=>{
    expect(source).toContain("o.source_type='opening_balance'");
    expect(source).toContain("a.source_type='manual_opening'");
    expect(source).toContain('Start-date running balance is evidence only; confirm against bank statement');
    expect(source).not.toContain('Promise.all([');
    expect(source).not.toMatch(/partner_ownership_periods.*amount|ownership_percentage.*partner_(?:capital|current|loan)/s);
  });

  it('audits sensitive lifecycle and item mutations',()=>{
    for(const action of [
      'opening_balance.create',
      'opening_balance_item.create',
      'opening_balance_item.update',
      'opening_balance_item.delete',
      'opening_balance.submit_review',
      'opening_balance.return_to_draft',
      'opening_balance.approve',
    ]) expect(source).toContain(`'${action}'`);
  });
});
