import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const accounting=readFileSync(new URL('../src/modules/accounting/accounting.router.ts',import.meta.url),'utf8');
const opening=readFileSync(new URL('../src/modules/opening-balances/opening-balances.router.ts',import.meta.url),'utf8');
const shared=readFileSync(new URL('../src/modules/accounting/journal-posting.ts',import.meta.url),'utf8');

describe('shared journal posting contract',()=>{
  it('normal accounting and opening-balance approval share one posting invariant',()=>{
    expect(accounting).toMatch(/postJournalInTransaction\(client,\s*companyId,\s*actor,\s*id\)/);
    expect(opening).toMatch(/postJournalInTransaction\(c,\s*companyId,\s*actor,\s*journal\.id\)/);
    expect(shared).toContain('Opening balance date must equal fiscal year start');
    expect(shared).toMatch(/assertAccountingDateWritable\(companyId,\s*journal\.accounting_date,\s*client\)/);
    expect(shared).toContain('A posted journal requires at least two lines');
    expect(shared).toContain('Inactive accounts cannot receive postings');
    expect(shared).toContain('Journal is not balanced');
    expect(shared).toContain('Journal total must match the operational source amount');
    expect(shared).toContain('enforceVatRecognition');
    expect(shared).toContain("action: 'journal.post'");
  });

  it('opening approval no longer directly posts a journal',()=>{
    const approve=opening.slice(opening.indexOf('async approve('),opening.indexOf('\n}\n\nconst service'));
    expect(approve).not.toContain("UPDATE journal_entries SET status='posted'");
    expect(approve).not.toContain('assertAccountingDateWritable');
    expect(approve).not.toContain('Journal is not balanced');
  });
});
