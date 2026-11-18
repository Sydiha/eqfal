import { describe, expect, it } from 'vitest';
import { previewZakatWorksheet } from '../src/modules/zakat-worksheets/zakat-worksheet.preview';

const account = (id: string, category: string, cents: string) => ({
  account_id: id, code: id, name: id, name_ar: null, name_en: id, statement_category: category,
  account_type: category === 'equity' ? 'equity' : category.includes('liability') ? 'liability' : 'asset',
  is_contra: false, amount_cents: cents,
});

describe('read-only Zakat worksheet preview', () => {
  it('maps FY2027 worksheet balances with exact SAR amounts and stays blocked for absent input evidence', () => {
    const result = previewZakatWorksheet({
      worksheet: { id: 'synthetic-fy27-worksheet', balances_snapshot: { accounts: [account('cash', 'current_asset', '123456'), account('capital', 'equity', '123456')] } },
      fiscalYear: { start_date: '2027-01-01', end_date: '2027-12-31' },
      functionalCurrency: 'SAR',
      classifications: [
        { account_id: 'cash', zakat_type: 'non_deductible_asset', evidence_document_id: null },
        { account_id: 'capital', zakat_type: 'equity_capital', evidence_document_id: null },
      ],
      adjustments: [],
      gates: [{ code: 'B3_rounding', status: 'unverified' }],
      ownershipQualified: false, ownershipBlockers: ['no_confirmed_ownership'], readinessBlockers: ['scope_declaration_missing'],
    });

    expect(result).toMatchObject({ status: 'BLOCKED', calculation_performed: false, final_zakat_base_halalas: null, payable_amount_halalas: null, totals: null, lines: [] });
    expect(result.missing_requirements).toEqual(expect.arrayContaining([
      'activity_period', 'regulatory_gates', 'finalized_book_result', 'adjusted_profit', 'asset_allocations', 'article73_assessment',
    ]));
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ACCOUNT_DECISION_REFERENCE_REQUIRED' }),
      expect.objectContaining({ code: 'FINALIZED_BOOK_RESULT_REQUIRED' }),
      expect.objectContaining({ code: 'ARTICLE_73_ASSESSMENT_REQUIRED' }),
    ]));
    expect(result.blocker_groups.user_data).toContain('finalized_book_result');
    expect(result.blocker_groups.regulatory_review).toEqual(expect.arrayContaining([
      'B0_amendment_1248', 'B3_rounding', 'B4_cap_ordering', 'B7_book_profit_after_zakat', 'B9_reference_cases_approval',
    ]));
    expect(result.blocker_groups.regulatory_review).toContain('regulatory_decision_evidence');
  });

  it('keeps an unclassified zero-balance account blocked under the worksheet classification rules', () => {
    const result = previewZakatWorksheet({
      worksheet: { id: 'synthetic-fy27-worksheet', balances_snapshot: { accounts: [account('zero-cash', 'current_asset', '0')] } },
      fiscalYear: { start_date: '2027-01-01', end_date: '2027-12-31' }, functionalCurrency: 'SAR',
      classifications: [], adjustments: [], gates: [], ownershipQualified: true, ownershipBlockers: [], readinessBlockers: [],
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.missing_requirements).toContain('account_classifications');
    expect(result.blocker_groups.user_data).toEqual(expect.arrayContaining(['account_classifications']));
    expect(result.blocker_groups.user_data).not.toContain('unclassified_balance');
    expect(result.final_zakat_base_halalas).toBeNull();
    expect(result.payable_amount_halalas).toBeNull();
  });

  it('does not map negative retained earnings to a verified carried-forward loss', () => {
    const result = previewZakatWorksheet({
      worksheet: { id: 'synthetic-fy27-worksheet', balances_snapshot: { accounts: [account('loss', 'equity', '-10000')] } },
      fiscalYear: { start_date: '2027-01-01', end_date: '2027-12-31' }, functionalCurrency: 'SAR',
      classifications: [{ account_id: 'loss', zakat_type: 'retained_earnings', evidence_document_id: null }],
      adjustments: [], gates: [], ownershipQualified: true, ownershipBlockers: [], readinessBlockers: [],
    });
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'CARRIED_FORWARD_LOSS_NOT_RECONCILED' }));
    expect(result.blocker_groups.user_data).toContain('loss_reconciliation');
    expect(result.status).toBe('BLOCKED');
    expect(result.payable_amount_halalas).toBeNull();
  });

  it('does not infer the required SAR source from a non-SAR functional currency', () => {
    const result = previewZakatWorksheet({
      worksheet: { id: 'synthetic-fy27-worksheet', balances_snapshot: { accounts: [account('capital', 'equity', '10000')] } },
      fiscalYear: { start_date: '2027-01-01', end_date: '2027-12-31' }, functionalCurrency: 'USD',
      classifications: [{ account_id: 'capital', zakat_type: 'equity_capital', evidence_document_id: null }], adjustments: [], gates: [],
      ownershipQualified: true, ownershipBlockers: [], readinessBlockers: [],
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.missing_requirements).toContain('functional_currency_sar');
    expect(result.lines).toEqual([]);
  });

  it('preserves worksheet ownership and readiness blockers in the read-only preview', () => {
    const result = previewZakatWorksheet({
      worksheet: null, fiscalYear: { start_date: '2027-01-01', end_date: '2027-12-31' },
      functionalCurrency: null, classifications: [], adjustments: [], gates: [],
      ownershipQualified: false, ownershipBlockers: ['partner_eligibility_missing'], readinessBlockers: ['balances_source_drift'],
    });
    expect(result).toMatchObject({ status: 'BLOCKED', lines: [], totals: null, worksheet_blockers: ['balances_source_drift', 'partner_eligibility_missing'] });
  });
});
