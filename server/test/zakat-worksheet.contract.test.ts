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
    for (const g of ['B0_amendment_1248', 'B3_rounding', 'B4_cap_ordering', 'B7_book_profit_after_zakat', 'B9_reference_cases_approval']) expect(migration).toMatch(new RegExp(`'${g}'.*TRUE\\)`));
  });
});

import { taxReadiness } from '../src/modules/annual-closing/annual-closing.service';

describe('Zakat worksheet and tax workpaper consistency in annual closing readiness', () => {
  const wp = (over: object = {}) => ({ accounting_profile_id: 'p', tax_path: 'zakat', workflow_status: 'approved', professional_review_required: false, unresolved: 0, source_drift: false, ...over });
  const zw = (over: object = {}) => ({ revision_no: 2, approved_snapshot_fingerprint: 'fp', source_drift: false, ...over });
  it('leaves the workpaper outcome and package summary untouched when no approved worksheet exists', () => {
    const r = taxReadiness('zakat', 'p', wp(), 0, null);
    expect(r.status).toBe('ready');
    expect(Object.keys(r.summary)).not.toContain('zakat_worksheet_revision');
  });
  it('reports the approved worksheet revision and fingerprint in the package summary', () => {
    const r = taxReadiness('zakat', 'p', wp(), 0, zw());
    expect(r).toMatchObject({ status: 'ready', summary: { zakat_worksheet_revision: 2, zakat_worksheet_snapshot_fingerprint: 'fp', calculation_performed: false } });
  });
  it('never makes an unapproved workpaper ready because a worksheet is approved', () => {
    const r = taxReadiness('zakat', 'p', wp({ workflow_status: 'draft' }), 0, zw());
    expect(r.ready).toBe(false); expect(r.summary.blockers).toContain('workpaper_not_approved');
  });
  it('blocks when an approved worksheet drifted from its sources, even with an approved workpaper', () => {
    const r = taxReadiness('zakat', 'p', wp(), 0, zw({ source_drift: true }));
    expect(r).toMatchObject({ status: 'blocked', ready: false });
    expect(r.summary.blockers).toContain('zakat_worksheet_source_drift');
  });
});
