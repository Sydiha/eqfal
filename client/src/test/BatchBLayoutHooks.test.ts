import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(new URL(`../components/${f}`, import.meta.url), 'utf8');

/* Batch B: presentation hooks must stay wired between markup and CSS. */
describe('Batch B layout hooks', () => {
  it.each([
    ['ZakatWorksheet', ['zw-declarations', 'zw-check', 'zw-class-form', 'zw-form--adj', 'zw-review-card', 'zw-reason']],
    ['ZakatRegulatoryReview', ['zw-review', 'zw-gate', 'zw-form--stack']],
  ])('%s classes exist in markup and ZakatWorksheet.css', (name, classes) => {
    const tsx = read(`${name}.tsx`); const css = read('ZakatWorksheet.css');
    for (const c of classes) { expect(tsx).toContain(c); expect(css).toContain(`.${c}`); }
  });
  it('bank reconciliation forms and sections are styled', () => {
    const tsx = read('BankStatementReconciliation.tsx'); const css = read('BankStatementReconciliation.css');
    for (const c of ['bsr-toolbar', 'bsr-form', 'bsr-section']) { expect(tsx).toContain(c); expect(css).toContain(`.${c}`); }
  });
  it('opening balance amounts are bidi-isolated and end-aligned', () => {
    expect(read('OpeningBalanceReview.tsx')).toContain('<bdi dir="ltr">{money(it.amount)}</bdi>');
    expect(read('OpeningBalanceReview.css')).toMatch(/td\.ob-num\{text-align:end/);
  });
});
