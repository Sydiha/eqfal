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

describe('S2 historical supplements in exports', () => {
  it('full-year cash flow export shows the supplement lines, fx effect and approved version', () => {
    const cf = statementExport({ ...base, kind: 'cashFlow', accountName: (a) => a.name, yearName: '2026', startDate: '2026-01-01', endDate: '2026-12-31',
      data: { statement: 'cash_flow', fx_effect: '5.00', opening_cash_and_cash_equivalents: '20000.00', net_change_in_cash_and_cash_equivalents: '315000.00', closing_cash_and_cash_equivalents: '335000.00',
        sections: [{ category: 'operating', total: '300000.00', native_total: '65000.00', pre_cutover_total: '235000.00', pre_cutover_lines: [{ label: 'Customer receipts', amount: '235000.00' }], accounts: [{ account_id: '1', code: '4000', name: 'Sales', amount: '65000.00' }] }],
        pre_cutover: disclosure({ completeness: { availability: 'ledger_calculated', full_year_complete: true, status: 'reconciled', reasons: [], supplement: { version_no: 2, state: 'complete', revision_pending: true } } }) } });
    const csv = toCsv(cf.rows);
    expect(csv).toContain('accounting.statements.preCutover.supplementLine: Customer receipts,235000.00');
    expect(csv).toContain('accounting.statements.preCutover.fxEffect,5.00');
    expect(csv).toContain('accounting.statements.preCutover.completeness,accounting.statements.preCutover.reconciled');
    expect(csv).toContain('accounting.statements.preCutover.supplementVersion,2 — accounting.statements.preCutover.revisionPending');
  });

  it('an invariant failure is disclosed with its stable code, never hidden', () => {
    const lines = preCutoverLines(t, disclosure({ completeness: { availability: 'post_cutover_only', full_year_complete: false, status: 'unverified', reasons: ['SUPPLEMENT_CASH_ROLLFORWARD_MISMATCH'] } }));
    expect(lines).toContainEqual(['', 'accounting.statements.preCutover.reasons.SUPPLEMENT_INVALID (SUPPLEMENT_CASH_ROLLFORWARD_MISMATCH)']);
  });

  it('changes in equity export lists pre-cutover movements by type', () => {
    const e = statementExport({ ...base, kind: 'changesInEquity', accountName: (a) => a.name, yearName: '2026', startDate: '2026-01-01', endDate: '2026-12-31',
      data: { statement: 'changes_in_equity', opening_equity: '155000.00', direct_equity_movements: '15000.00', current_period_earnings: '180000.00', closing_equity: '350000.00', pre_cutover_equity: { movements_by_type: { contribution: '15000.00', distribution: '0.00', transfer: '0.00', other: '0.00' } } } });
    const csv = toCsv(e.rows);
    expect(csv).toContain('accounting.statements.preCutover.supplementLine: accounting.statements.preCutover.movement.contribution,15000.00');
    expect(csv).not.toContain('movement.distribution');
  });

  it('every S2 key is translated in Arabic and English', () => {
    const keys = ['reconciled', 'supplementVersion', 'revisionPending', 'supplementLine', 'fxEffect', 'movement.contribution', 'movement.distribution', 'movement.transfer', 'movement.other',
      'reasons.REPORT_RANGE_NOT_FULL_YEAR', 'reasons.CUTOVER_RANGE_NOT_FROM_YEAR_START', 'reasons.SUPPLEMENT_LEDGER_FINGERPRINT_CHANGED', 'reasons.SUPPLEMENT_INVALID'].map((k) => `accounting.statements.preCutover.${k}`);
    keys.push('errors.warnings.cutover_cash_flow_supplement_missing', 'errors.warnings.cutover_equity_supplement_missing', 'annualClosing.manifestNames.pre_cutover_cash_flow', 'annualClosing.manifestNames.pre_cutover_equity');
    for (const lng of ['ar', 'en']) for (const k of keys) expect(i18n.exists(k, { lng }), `${lng}:${k}`).toBe(true);
  });
});
