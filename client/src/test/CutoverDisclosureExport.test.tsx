import { describe, expect, it } from 'vitest';
import { toCsv } from '../export/downloadExport';
import { preCutoverLines, statementExport, type PreCutover } from '../export/reportExport';
import i18n from '../i18n';

const t = (k: string) => k;
const base = { ar: false, company: 'Acme Co', generatedAt: '2026-10-21 07:00 UTC', t };
const disclosure = (o: Partial<PreCutover> = {}): PreCutover => ({
  cutover_date: '2025-09-30', tb_reference: 'TB-1', tb_prepared_by: 'A', tb_source_system: 'Legacy ERP', tb_basis: 'pre_closing_acknowledged', evidence_missing: [],
  limitations: ['PRE_CUTOVER_ACCOUNT_LEVEL_ONLY'],
  completeness: { availability: 'ledger_calculated', full_year_complete: false, status: 'unverified', reasons: ['HISTORICAL_SUPPLEMENTS_NOT_AVAILABLE'] }, ...o,
});
const sections = [{ category: 'revenue', total: '450.00', imported_total: '300.00', native_total: '150.00', accounts: [{ account_id: '1', code: '4000', name: 'Sales', amount: '450.00', imported_amount: '300.00', native_amount: '150.00' }] }];

describe('S1 cut-over disclosure in exports', () => {
  it('profit or loss export carries imported / native columns and the disclosure', () => {
    const pl = statementExport({ ...base, kind: 'profitOrLoss', accountName: (a) => a.name, yearName: '2025', startDate: '2025-01-01', endDate: '2025-12-31',
      data: { statement: 'profit_or_loss', sections, profit_or_loss: '180.00', profit_or_loss_split: { imported: '120.00', native: '60.00' }, pre_cutover: disclosure() } });
    const csv = toCsv(pl.rows);
    expect(csv).toContain('accounting.account,accounting.statements.preCutover.imported,accounting.statements.preCutover.native,accounting.statements.preCutover.amount');
    expect(csv).toContain('4000 — Sales,300.00,150.00,450.00');
    expect(csv).toContain('accounting.statements.profitOrLoss,120.00,60.00,180.00');
    expect(csv).toContain('accounting.statements.preCutover.cutoverDate,2025-09-30');
    expect(csv).toContain('accounting.statements.preCutover.completeness,accounting.statements.preCutover.unverified');
    expect(csv).toContain('accounting.statements.preCutover.reasons.HISTORICAL_SUPPLEMENTS_NOT_AVAILABLE');
  });

  it('a legacy activation discloses missing evidence instead of inventing it', () => {
    const lines = preCutoverLines(t, disclosure({ tb_basis: 'not_recorded', tb_source_system: null, evidence_missing: ['TB_BASIS_NOT_RECORDED'],
      completeness: { availability: 'post_cutover_only', full_year_complete: false, status: 'unverified', reasons: ['TB_BASIS_NOT_RECORDED'] } }));
    expect(lines).toContainEqual(['accounting.statements.preCutover.sourceSystem', 'accounting.statements.preCutover.notRecorded']);
    expect(lines).toContainEqual(['accounting.statements.preCutover.basis', 'accounting.statements.preCutover.basisNotRecorded']);
    expect(lines).toContainEqual(['accounting.statements.preCutover.availability', 'accounting.statements.preCutover.postCutoverOnly']);
  });

  it('January-1 statements export exactly as before (no disclosure, two columns)', () => {
    const plain = [{ category: 'revenue', total: '10.00', accounts: [{ account_id: '1', code: '4000', name: 'Sales', amount: '10.00' }] }];
    const pl = statementExport({ ...base, kind: 'profitOrLoss', accountName: (a) => a.name, yearName: '2026', startDate: '2026-01-01', endDate: '2026-12-31', data: { statement: 'profit_or_loss', sections: plain, profit_or_loss: '10.00' } });
    const csv = toCsv(pl.rows);
    expect(csv).not.toContain('preCutover');
    expect(csv).toContain('accounting.account,Amount');
    expect(csv).toContain('accounting.statements.profitOrLoss,10.00');
  });

  it('every disclosure, reason, limitation and close-warning key is translated in Arabic and English', () => {
    const keys = ['title', 'intro', 'cutoverDate', 'tbReference', 'preparedBy', 'sourceSystem', 'basis', 'basisAcknowledged', 'basisNotRecorded', 'notRecorded', 'completeness', 'unverified', 'availability', 'ledgerCalculated', 'postCutoverOnly', 'imported', 'native', 'amount',
      'reasons.HISTORICAL_SUPPLEMENTS_NOT_AVAILABLE', 'reasons.TB_BASIS_NOT_RECORDED', 'reasons.TB_SOURCE_SYSTEM_NOT_RECORDED', 'reasons.PRE_CUTOVER_EQUITY_MOVEMENTS_NOT_RECORDED', 'reasons.PRE_CUTOVER_CASH_FLOWS_NOT_RECORDED',
      'limitations.title', 'limitations.PRE_CUTOVER_ACCOUNT_LEVEL_ONLY', 'limitations.PRE_CUTOVER_PNL_AGGREGATED_AT_CUTOVER_DATE', 'limitations.HISTORICAL_DATA_NOT_VERIFIED_BY_EQFAL'].map((k) => `accounting.statements.preCutover.${k}`);
    keys.push('errors.warnings.cutover_historical_supplements_missing', 'errors.warnings.cutover_tb_evidence_missing', 'annualClosing.domainNames.pre_cutover_history', 'annualClosing.manifestNames.pre_cutover_history');
    for (const lng of ['ar', 'en']) for (const k of keys) expect(i18n.exists(k, { lng }), `${lng}:${k}`).toBe(true);
  });
});
