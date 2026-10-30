import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// G6-1 static contracts: every route is capability-gated with the existing capabilities; the migration adds no capability and no amount column.
const router = readFileSync(new URL('../src/modules/zakat-worksheets/zakat-worksheet.router.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/105_zakat_worksheets.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
const cap = (needle: string) => router.split('\n').find((l) => l.includes(needle)) ?? '';

describe('Zakat worksheet route contract', () => {
  it.each([
    ["get('/zakat-worksheets/:fiscalYearId'", 'tax_workpaper.view'],
    ["post('/zakat-worksheets/:fiscalYearId',", 'tax_workpaper.create'],
    ["patch('/zakat-worksheets/:fiscalYearId/declarations'", 'tax_workpaper.edit'],
    ["post('/zakat-worksheets/:fiscalYearId/refresh'", 'tax_workpaper.edit'],
    ["put('/zakat-worksheets/:fiscalYearId/classifications/:accountId'", 'tax_workpaper.edit'],
    ["delete('/zakat-worksheets/:fiscalYearId/classifications/:accountId'", 'tax_workpaper.edit'],
    ["post('/zakat-worksheets/:fiscalYearId/adjustments'", 'tax_workpaper.adjustment.create'],
    ["patch('/zakat-worksheets/:fiscalYearId/adjustments/:id'", 'tax_workpaper.adjustment.edit'],
    ["delete('/zakat-worksheets/:fiscalYearId/adjustments/:id'", 'tax_workpaper.adjustment.delete'],
    ["post('/zakat-worksheets/:fiscalYearId/submit'", 'tax_workpaper.submit'],
    ["post('/zakat-worksheets/:fiscalYearId/review'", 'tax_workpaper.review'],
    ["post('/zakat-worksheets/:fiscalYearId/return'", 'tax_workpaper.review'],
    ["post('/zakat-worksheets/:fiscalYearId/approve'", 'tax_workpaper.approve'],
    ["post('/zakat-worksheets/:fiscalYearId/revise'", 'tax_workpaper.approve'],
    ["get('/zakat-eligibility'", 'tax_workpaper.view'],
    ["post('/zakat-eligibility',", 'partner.ownership.create'],
  ])('%s requires %s', (route, capability) => { expect(cap(route)).toContain(`requireCapability('${capability}')`); });
  it('gates eligibility confirmation, end-dating and removal with the partner ownership capabilities', () => {
    expect(router).toContain("eligibilityAction('partner.ownership.confirm', '/confirm'");
    expect(router).toContain("eligibilityAction('partner.ownership.edit', '/end'");
    expect(router).toContain("eligibilityAction('partner.ownership.edit', '', versionOnly");
  });
  it('requires same-origin protection on every write and never exposes a gate-verification route', () => {
    expect(router).not.toMatch(/regulatory-gates/);
    for (const line of router.split('\n').filter((l) => /zakatWorksheetRouter\.(post|put|patch|delete)\(/.test(l))) expect(line).toContain('...write');
  });
});

describe('migration 105', () => {
  it('is additive, introduces no capability, no payable amount and seeds every gate as unverified', () => {
    expect(migration).not.toMatch(/INSERT INTO capabilities/i);
    expect(migration).not.toMatch(/payable|zakat_due|zakat_amount/i);
    expect(migration).not.toMatch(/\bDROP\b|\bALTER TABLE\b/i);
    expect(migration.match(/INSERT INTO zakat_regulatory_gates[\s\S]*?;/)![0]).not.toMatch(/'verified'/);
    for (const g of ['B0_amendment_1248', 'B3_rounding', 'B4_cap_ordering', 'B7_book_profit_after_zakat']) expect(migration).toMatch(new RegExp(`'${g}'.*TRUE\\)`));
  });
});
