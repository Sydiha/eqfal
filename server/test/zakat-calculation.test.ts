import { describe, expect, it } from 'vitest';
import {
  assertAggregateLiabilityResultResolved,
  assertArticle73Interpretable,
  calculateArticle25Placement,
  calculatePeriodZakat,
  calculatePeriodZakatFromExactHalalas,
  calculateProfitDifference,
  parseSarToHalalas,
  PROVISIONAL_DEFAULT_CALCULATION_OPTIONS,
  ZakatInputError,
  ZakatUnresolvedError,
} from '../src/modules/zakat-calculation/zakat-calculation';

describe('strict SAR integer arithmetic', () => {
  it.each([
    ['12.34', 1234n],
    ['-0.05', -5n],
    ['0', 0n],
  ])('parses %s into exact halalas', (value, expected) => {
    expect(parseSarToHalalas(value)).toBe(expected);
  });

  it.each(['', '1.234', '1,000.00', '1e3', ' 1.00', '+1.00', '01.00', 'NaN'])('rejects malformed SAR input %s', (value) => {
    expect(() => parseSarToHalalas(value)).toThrow(ZakatInputError);
  });
});

describe('Article 15 period calculation', () => {
  it.each([
    [354, '2500.00'],
    [365, '2577.68'],
    [366, '2584.75'],
  ])('uses 354 denominator and %i actual fiscal-year days', (days, expectedSar) => {
    const result = calculatePeriodZakat('100000.00', days);
    expect(result).toMatchObject({
      denominatorDays: 354,
      fiscalYearDays: days,
      finalAmountHalalas: parseSarToHalalas(expectedSar).toString(),
      roundingMode: 'HALF_UP',
      roundingPolicyStatus: 'provisional',
    });
  });

  it('applies Article 15 short-period treatment by activity boundary and fails closed when unknown', () => {
    const commencement = calculatePeriodZakat('100000.00', 353, PROVISIONAL_DEFAULT_CALCULATION_OPTIONS, 'commencement');
    expect(commencement.disposition).toBe('calculated');
    expect(commencement.finalAmountHalalas).toBe('249294');

    const cessation = calculatePeriodZakat('100000.00', 353, PROVISIONAL_DEFAULT_CALCULATION_OPTIONS, 'cessation');
    expect(cessation).toMatchObject({ disposition: 'exempt', exactHalalas: null, finalAmountHalalas: null });
    expect(() => calculatePeriodZakat('100000.00', 353)).toThrowError(expect.objectContaining({ code: 'ARTICLE15_SHORT_PERIOD_CONTEXT_UNRESOLVED' }));
  });

  it('allows the caller to select an explicit final rounding policy and marks it provisional', () => {
    const halfUp = calculatePeriodZakat('100.20', 354, { finalRounding: 'HALF_UP' });
    const halfEven = calculatePeriodZakat('100.20', 354, { finalRounding: 'HALF_EVEN' });
    const down = calculatePeriodZakat('100.20', 354, { finalRounding: 'DOWN' });
    expect(halfUp.exactHalalas).toEqual({ numerator: '501', denominator: '2' });
    expect(halfUp.finalAmountHalalas).toBe('251');
    expect(halfEven.finalAmountHalalas).toBe('250');
    expect(down.finalAmountHalalas).toBe('250');
    expect([halfUp, halfEven, down].every((result) => result.roundingPolicyStatus === 'provisional')).toBe(true);
    expect(PROVISIONAL_DEFAULT_CALCULATION_OPTIONS.finalRounding).toBe('HALF_UP');
  });

  it('keeps a fractional-halalah base exact through Article 15 and rounds only the final amount', () => {
    const result = calculatePeriodZakatFromExactHalalas({ numerator: '10001', denominator: '3' }, 354, { finalRounding: 'HALF_UP' });
    expect(result.exactHalalas).toEqual({ numerator: '10001', denominator: '120' });
    expect(result.finalAmountHalalas).toBe('83');
    expect(result.roundingPolicyStatus).toBe('provisional');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid fiscal-year day count %s', (days) => {
    expect(() => calculatePeriodZakat('100.00', days)).toThrow(ZakatInputError);
  });

  it('rejects a negative base and unsupported rounding mode', () => {
    expect(() => calculatePeriodZakat('-0.01', 354)).toThrow(/cannot be negative/);
    expect(() => calculatePeriodZakat('100.00', 354, { finalRounding: 'UNSET' as never })).toThrow(/finalRounding/);
  });
});

describe('Article 23(3) finalized profit difference', () => {
  it.each([
    ['120000.00', '90000.00', '3000000'],
    ['-30000.00', '-20000.00', '-1000000'],
    ['0.00', '0.00', '0'],
  ])('preserves the signed difference for adjusted=%s and finalized book=%s', (adjusted, finalizedBookAfterActualCharges, expected) => {
    expect(calculateProfitDifference(adjusted, finalizedBookAfterActualCharges).differenceHalalas).toBe(expected);
  });

  it('fails closed when a finalized accounting input is missing; it never inserts a hypothetical provision', () => {
    expect(() => calculateProfitDifference('100.00', null)).toThrow(ZakatUnresolvedError);
    expect(() => calculateProfitDifference(undefined, '90.00')).toThrow(/finalized accounting inputs/);
  });

  it('rejects malformed finalized accounting inputs', () => {
    expect(() => calculateProfitDifference('100.001', '90.00')).toThrow(ZakatInputError);
  });
});

describe('Article 25 individually supported placement calculations', () => {
  const example = {
    totalCurrentAssetsSar: '100000.00',
    deductedCurrentAssetSar: '20000.00',
    currentLiabilitiesSar: '30000.00',
    totalNonCurrentAssetsSar: '100000.00',
    nonDeductedNonCurrentAssetSar: '20000.00',
    nonCurrentLiabilitiesSar: '40000.00',
  };

  it('calculates the exact current allocation and non-current exclusion separately', () => {
    expect(calculateArticle25Placement(example)).toEqual({
      currentLiabilitiesAddedHalalas: { numerator: '600000', denominator: '1' },
      nonCurrentLiabilitiesExcludedHalalas: { numerator: '800000', denominator: '1' },
      nonCurrentLiabilitiesRemainingHalalas: { numerator: '3200000', denominator: '1' },
    });
  });

  it('caps each Article 25 placement at its specified asset amount', () => {
    const result = calculateArticle25Placement({
      ...example,
      currentLiabilitiesSar: '200000.00',
      nonCurrentLiabilitiesSar: '200000.00',
    });
    expect(result.currentLiabilitiesAddedHalalas).toEqual({ numerator: '2000000', denominator: '1' });
    expect(result.nonCurrentLiabilitiesExcludedHalalas).toEqual({ numerator: '2000000', denominator: '1' });
    expect(result.nonCurrentLiabilitiesRemainingHalalas).toEqual({ numerator: '18000000', denominator: '1' });
  });

  it('preserves fractional halalas exactly without intermediate rounding', () => {
    const result = calculateArticle25Placement({
      ...example,
      totalCurrentAssetsSar: '3.00',
      deductedCurrentAssetSar: '1.00',
      currentLiabilitiesSar: '1.00',
    });
    expect(result.currentLiabilitiesAddedHalalas).toEqual({ numerator: '100', denominator: '3' });
  });

  it('rejects negative amounts, zero denominators, and deductions exceeding asset totals', () => {
    expect(() => calculateArticle25Placement({ ...example, currentLiabilitiesSar: '-1.00' })).toThrow(ZakatInputError);
    expect(() => calculateArticle25Placement({ ...example, totalCurrentAssetsSar: '0.00' })).toThrow(/denominators must be positive/);
    expect(() => calculateArticle25Placement({ ...example, deductedCurrentAssetSar: '100001.00' })).toThrow(/cannot exceed/);
  });
});

describe('unresolved cases fail closed', () => {
  it('allows an aggregate total within the cap, but blocks when liability additions exceed it', () => {
    expect(() => assertAggregateLiabilityResultResolved({
      totalLiabilityAdditionsHalalas: { numerator: '4000', denominator: '1' },
      totalDeductedAssetsSar: '50.00',
    })).not.toThrow();
    expect(() => assertAggregateLiabilityResultResolved({
      totalLiabilityAdditionsHalalas: { numerator: '4000', denominator: '1' },
      article29ResidualAdditionHalalas: { numerator: '2000', denominator: '1' },
      totalDeductedAssetsSar: '50.00',
    })).toThrowError(expect.objectContaining({ code: 'AGGREGATE_LIABILITY_CAP_UNRESOLVED' }));
  });

  it('rejects invalid exact-fraction inputs for aggregate checks', () => {
    expect(() => assertAggregateLiabilityResultResolved({
      totalLiabilityAdditionsHalalas: { numerator: '-1', denominator: '1' },
      totalDeductedAssetsSar: '50.00',
    })).toThrow(ZakatInputError);
  });

  it('allows a confirmed no-activity Article 73 scope, but blocks relevant activity and invalid scope', () => {
    expect(() => assertArticle73Interpretable(false)).not.toThrow();
    expect(() => assertArticle73Interpretable(true)).toThrowError(expect.objectContaining({ code: 'ARTICLE_73_INTERPRETATION_REQUIRED' }));
    expect(() => assertArticle73Interpretable('unknown' as never)).toThrow(ZakatInputError);
  });
});
