import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const accounting = readFileSync('server/src/modules/accounting/accounting.router.ts', 'utf8');
const opening = readFileSync('server/src/modules/opening-balances/opening-balances.router.ts', 'utf8');
const shared = readFileSync('server/src/modules/accounting/journal-posting.ts', 'utf8');

test('normal accounting and opening-balance approval share one posting invariant', () => {
  assert.match(accounting, /postJournalInTransaction\(client,companyId,actor,id\)/);
  assert.match(opening, /postJournalInTransaction\(c,companyId,actor,journal\.id\)/);

  assert.match(shared, /Opening balance date must equal fiscal year start/);
  assert.match(shared, /assertAccountingDateWritable\(companyId, journal\.accounting_date, client\)/);
  assert.match(shared, /A posted journal requires at least two lines/);
  assert.match(shared, /Inactive accounts cannot receive postings/);
  assert.match(shared, /Journal is not balanced/);
  assert.match(shared, /Journal total must match the operational source amount/);
  assert.match(shared, /enforceVatRecognition/);
  assert.match(shared, /action: 'journal\.post'/);
});

test('opening approval no longer directly posts a journal', () => {
  const approve = opening.slice(opening.indexOf('async approve('), opening.indexOf('\n}\n\nconst service'));
  assert.doesNotMatch(approve, /UPDATE journal_entries SET status='posted'/);
  assert.doesNotMatch(approve, /assertAccountingDateWritable/);
  assert.doesNotMatch(approve, /Journal is not balanced/);
});
