import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const opening=readFileSync(new URL('../src/modules/opening-balances/opening-balances.router.ts',import.meta.url),'utf8');

describe('opening balance posting integration contract',()=>{
  it('creates a draft opening journal then delegates canonical posting',()=>{
    expect(opening).toMatch(/entry_type,status,created_by\) VALUES\([^\n]*'opening_balance','draft'/);
    expect(opening).toMatch(/postJournalInTransaction\(c,\s*companyId,\s*actor,\s*journal\.id\)/);
    expect(opening).toMatch(/status='approved',journal_entry_id=\$3,approved_by=\$4/);
  });

  it('groups operational detail before ledger posting',()=>{
    expect(opening).toMatch(/new Map<string,\{accountId:string;side:string;amount:number;code:string\}>/);
    expect(opening).toMatch(/const k=`\$\{x\.account_id\}:\$\{x\.balance_side\}`/);
    expect(opening).toMatch(/sort\(\(a,b\)=>a\.code\.localeCompare\(b\.code\)\|\|a\.side\.localeCompare\(b\.side\)\)/);
  });
});
