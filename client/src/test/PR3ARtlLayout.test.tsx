import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { transactionOptionLabel } from '../components/bankTransactionLabel';
import { formatDisplayDate } from '../date-format';

const strip = (s: string) => s.replace(/[⁦⁨⁩]/g, '');
const css = (name: string) => readFileSync(resolve(__dirname, '../components', name), 'utf8');

describe('PR-3A transaction option label', () => {
  const base = { id: 't1', bank_reference: 'REF-1' };
  it('keeps the original text, date and amount and isolates each part', () => {
    const label = transactionOptionLabel({ ...base, transaction_date: '2026-03-15', description: 'دفعة مورد Al-Rajhi Co.', amount: '-4300.50' });
    expect(strip(label)).toBe('2026-03-15 · دفعة مورد Al-Rajhi Co. · -4,300.50');
    expect(label).toContain('⁦-4,300.50⁩');
    expect(label).toContain('⁨دفعة مورد Al-Rajhi Co.⁩');
    expect(label).toContain('⁦2026-03-15⁩');
  });
  it('falls back to bank reference then id and formats positive amounts', () => {
    expect(strip(transactionOptionLabel({ ...base, transaction_date: '2026-03-14', description: null, amount: '12500.00' }))).toBe('2026-03-14 · REF-1 · 12,500.00');
    expect(strip(transactionOptionLabel({ id: 't9', bank_reference: null, transaction_date: '2026-03-14', description: '', amount: '1.5' }))).toContain(' t9 · ');
  });
});

describe('PR-3A mobile layout rules', () => {
  it('stacks the annual closing tables instead of forcing a 520px scroll', () => {
    const c = css('AnnualClosing.css');
    expect(c).toMatch(/\.table-wrap\.ac-stack table\{display:block;min-width:0/);
    expect(c).toMatch(/td:not\(:first-child\)::before\{content:attr\(data-label\)/);
  });
  it('lets opening-balance references wrap', () => {
    const c = css('OpeningBalanceReview.css');
    expect(c).toMatch(/@media \(max-width:760px\)\{\s*\/\*[^*]*\*\/\s*\.opening-balance-view \.ob-table table\{min-width:0;width:100%\}/);
    expect(c).toMatch(/\.ob-table td\{min-width:0;overflow-wrap:anywhere\}/);
    expect(c).toMatch(/\.ob-sub bdi\{unicode-bidi:isolate;overflow-wrap:anywhere\}/);
  });
});

describe('PR-3B settlement panel mobile layout', () => {
  it('drops the forced table min-width and stacks rows with labelled cells on narrow screens', () => {
    const c = css('banking-workspace.css');
    expect(c).toMatch(/@media\(max-width:58em\)\{\s*\.settlement-scroll\{--table-min-width:0!important\}/);
    expect(c).toMatch(/\.settlement-stack td::before\{content:attr\(data-label\)/);
    expect(c).toMatch(/\.settlement-form-row\{flex-direction:column/);
  });
  it('labels every allocation and history cell so no value or action loses its caption', () => {
    const src = readFileSync(resolve(__dirname, '../components/SettlementPanel.tsx'), 'utf8');
    expect((src.match(/data-label=/g) ?? []).length).toBe(8);
    expect(src).toContain('settlement-stack--alloc');
    expect(src).toContain('settlement-stack--history');
    expect(src.match(/settlement-form-row/g)?.length).toBe(2);
  });
});

describe('PR-3C RTL polish', () => {
  const read = (name: string) => readFileSync(resolve(__dirname, '../components', name), 'utf8');
  it('isolates mixed-direction obligation names and references with bdi dir=auto', () => {
    const o = read('Obligations.tsx');
    expect(o).toContain('<bdi dir="auto">{referenceOf(selected)}</bdi>');
    expect(o).toContain('<bdi dir="auto">{selected.counterparty_name}</bdi>');
    expect(o).toContain('<bdi dir="auto">{referenceOf(o)}</bdi>');
    expect(o.match(/<bdi dir="auto">\{o\.counterparty_name\}<\/bdi>/g)?.length).toBe(1);
    expect(o).toContain('aria-label={`${L.view} ${o.counterparty_name}`}');
    expect(o.match(/aria-label=\{`[^`]*`\}/g)?.some(l => /<bdi/.test(l))).toBe(false);
  });
  it('keeps annual closing tabs in one scrollable row on phones', () => {
    const c = css('AnnualClosing.css');
    expect(c).toMatch(/\.ac-tabs\{flex-wrap:nowrap\}/);
    expect(c).toMatch(/\.ac-tab\{flex:1 1 0;min-width:0/);
      });
  it('formats the fiscal-year range with formatDisplayDate', () => {
    const a = read('AnnualClosing.tsx');
    expect(a).toContain('formatDisplayDate(selectedYear.start_date,i18n.language)');
    expect(a).toContain('formatDisplayDate(selectedYear.end_date,i18n.language)');
    expect(formatDisplayDate('2026-01-01', 'en')).toBe('01/01/2026');
    expect(formatDisplayDate('2026-12-31', 'ar').replace(/\u200f/g, '')).toBe('31/12/2026');
  });
});
