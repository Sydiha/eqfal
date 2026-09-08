import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const opening=readFileSync(new URL('../src/modules/opening-balances/opening-balances.router.ts',import.meta.url),'utf8');

describe('opening balance posting integration contract',()=>{
  it('creates a draft opening journal then delegates canonical posting',()=>{
    expect(opening).toMatch(/entry_type,status,created_by\) VALUES\([^\n]*'opening_balance','draft'/);
    expect(opening).toMatch(/postJournalInTransaction\(c,\s*companyId,\s*actor,\s*journal\.id\)/);
    expect(opening).toMatch(/status='approved',journal_entry_id=\$3,approved_by=\$4/);
  });

  it('nets operational detail by account in PostgreSQL before ledger posting',()=>{
    expect(opening).toContain("SUM(CASE WHEN i.balance_side='debit' THEN i.amount ELSE -i.amount END) net");
    expect(opening).toContain('GROUP BY i.account_id,a.code');
    expect(opening).toContain('WHERE net<>0 ORDER BY account_code,account_id');
    expect(opening).toContain("CASE WHEN net>0 THEN net::text ELSE '0.00' END debit");
    expect(opening).toContain("CASE WHEN net<0 THEN (-net)::text ELSE '0.00' END credit");
  });
});
