import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const opening = readFileSync('server/src/modules/opening-balances/opening-balances.router.ts', 'utf8');

test('opening approval creates a draft opening journal then delegates canonical posting', () => {
  assert.match(opening, /entry_type,status,created_by\) VALUES\([^\n]*'opening_balance','draft'/);
  assert.match(opening, /postJournalInTransaction\(c,companyId,actor,journal\.id\)/);
  assert.match(opening, /status='approved',journal_entry_id=\$3,approved_by=\$4/);
});

test('opening approval groups operational detail before ledger posting', () => {
  assert.match(opening, /new Map<string,\{accountId:string;side:string;amount:number;code:string\}>/);
  assert.match(opening, /const k=`\$\{x\.account_id\}:\$\{x\.balance_side\}`/);
  assert.match(opening, /sort\(\(a,b\)=>a\.code\.localeCompare\(b\.code\)\|\|a\.side\.localeCompare\(b\.side\)\)/);
});
