/**
 * Isolated Zakat calculation primitives. This module has no persistence or application integrations.
 * HALF_UP is an explicit provisional EQFAL output policy, not regulatory approval.
 */

export type FinalRoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN';
export type CalculationOptions = { finalRounding: FinalRoundingMode };
export type Article15ActivityPeriod = 'regular' | 'commencement' | 'cessation' | 'unresolved';
export const PROVISIONAL_DEFAULT_CALCULATION_OPTIONS: CalculationOptions = { finalRounding: 'HALF_UP' };

export type ExactHalalas = { numerator: string; denominator: string };
export type PeriodRateResult = {
  disposition: 'calculated' | 'exempt';
  denominatorDays: 354;
  fiscalYearDays: number;
  exactHalalas: ExactHalalas | null;
  finalAmountHalalas: string | null;
  roundingMode: FinalRoundingMode;
  roundingPolicyStatus: 'provisional';
};

export class ZakatInputError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ZakatInputError';
  }
}

export class ZakatUnresolvedError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ZakatUnresolvedError';
  }
}

const SAR_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const UNSIGNED_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const HIJRI_YEAR_DAYS = 354n;
const ZAKAT_RATE_BPS = 250n; // 2.5%; Article 15.
const BASIS_POINTS = 10_000n;

/** Strict SAR parser: decimal strings only, at most two decimals, no floats or exponent notation. */
export function parseSarToHalalas(value: unknown, field = 'amount'): bigint {
  if (typeof value !== 'string' || !SAR_PATTERN.test(value)) {
    throw new ZakatInputError(`${field} must be a decimal SAR string with at most two fractional digits`, 'INVALID_SAR_AMOUNT');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const halalas = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -halalas : halalas;
}

export function formatHalalas(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function positiveInteger(value: unknown, field: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ZakatInputError(`${field} must be a positive safe integer`, 'INVALID_DAY_COUNT');
  }
  return BigInt(value);
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x || 1n;
}

function fraction(numerator: bigint, denominator: bigint): ExactHalalas {
  if (denominator <= 0n) throw new ZakatInputError('denominator must be positive', 'INVALID_DENOMINATOR');
  const divisor = gcd(numerator, denominator);
  return { numerator: (numerator / divisor).toString(), denominator: (denominator / divisor).toString() };
}

function roundRational(numerator: bigint, denominator: bigint, mode: FinalRoundingMode): bigint {
  if (denominator <= 0n) throw new ZakatInputError('denominator must be positive', 'INVALID_DENOMINATOR');
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  let increment = false;
  if (mode === 'HALF_UP') increment = remainder * 2n >= denominator;
  else if (mode === 'HALF_EVEN') increment = remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n !== 0n);
  else if (mode !== 'DOWN') throw new ZakatInputError('unsupported rounding mode', 'INVALID_ROUNDING_MODE');
  return sign * (quotient + (increment ? 1n : 0n));
}

/** Article 15: 2.5% / 354 Hijri-year days × actual fiscal-year days. */
export function calculatePeriodZakat(
  zakatBaseSar: string,
  fiscalYearDays: number,
  options: CalculationOptions = PROVISIONAL_DEFAULT_CALCULATION_OPTIONS,
  activityPeriod: Article15ActivityPeriod = 'unresolved',
): PeriodRateResult {
  const baseHalalas = parseSarToHalalas(zakatBaseSar, 'zakatBaseSar');
  if (baseHalalas < 0n) throw new ZakatInputError('zakat base cannot be negative', 'NEGATIVE_ZAKAT_BASE');
  return calculatePeriodZakatFromExactHalalas({ numerator: baseHalalas.toString(), denominator: '1' }, fiscalYearDays, options, activityPeriod);
}

/** Applies Article 15 to an exact base expressed in rational halalas, without intermediate rounding. */
export function calculatePeriodZakatFromExactHalalas(
  baseHalalas: ExactHalalas,
  fiscalYearDays: number,
  options: CalculationOptions = PROVISIONAL_DEFAULT_CALCULATION_OPTIONS,
  activityPeriod: Article15ActivityPeriod = 'unresolved',
): PeriodRateResult {
  if (!baseHalalas || !UNSIGNED_INTEGER_PATTERN.test(baseHalalas.numerator) || !UNSIGNED_INTEGER_PATTERN.test(baseHalalas.denominator) || BigInt(baseHalalas.denominator) === 0n) {
    throw new ZakatInputError('baseHalalas must be a nonnegative exact fraction', 'INVALID_EXACT_AMOUNT');
  }
  const numeratorBase = BigInt(baseHalalas.numerator);
  const denominatorBase = BigInt(baseHalalas.denominator);
  if (numeratorBase < 0n) throw new ZakatInputError('zakat base cannot be negative', 'NEGATIVE_ZAKAT_BASE');
  const days = positiveInteger(fiscalYearDays, 'fiscalYearDays');
  if (!['regular', 'commencement', 'cessation', 'unresolved'].includes(activityPeriod)) {
    throw new ZakatInputError('activityPeriod is invalid', 'INVALID_ARTICLE15_ACTIVITY_PERIOD');
  }
  if (!options || !['HALF_UP', 'HALF_EVEN', 'DOWN'].includes(options.finalRounding)) {
    throw new ZakatInputError('finalRounding must be HALF_UP, HALF_EVEN, or DOWN', 'INVALID_ROUNDING_MODE');
  }
  if (days < HIJRI_YEAR_DAYS && activityPeriod === 'cessation') {
    return {
      disposition: 'exempt', denominatorDays: 354, fiscalYearDays, exactHalalas: null, finalAmountHalalas: null,
      roundingMode: options.finalRounding, roundingPolicyStatus: 'provisional',
    };
  }
  if (days < HIJRI_YEAR_DAYS && activityPeriod !== 'commencement') {
    throw new ZakatUnresolvedError('Article 15 short period applicability is unresolved; only a confirmed commencement period is rate-calculated.', 'ARTICLE15_SHORT_PERIOD_CONTEXT_UNRESOLVED');
  }
  const numerator = numeratorBase * ZAKAT_RATE_BPS * days;
  const denominator = denominatorBase * BASIS_POINTS * HIJRI_YEAR_DAYS;
  return {
    disposition: 'calculated',
    denominatorDays: 354,
    fiscalYearDays,
    exactHalalas: fraction(numerator, denominator),
    finalAmountHalalas: roundRational(numerator, denominator, options.finalRounding).toString(),
    roundingMode: options.finalRounding,
    roundingPolicyStatus: 'provisional',
  };
}

/** Article 23(3): adjusted profit/loss less the supplied finalized book result after actually recorded charges. */
export function calculateProfitDifference(
  adjustedNetResultSar: string | null | undefined,
  finalizedBookResultAfterActualZakatAndTaxSar: string | null | undefined,
): { differenceHalalas: string } {
  if (adjustedNetResultSar == null || finalizedBookResultAfterActualZakatAndTaxSar == null) {
    throw new ZakatUnresolvedError('finalized accounting inputs are required; no provision is inferred', 'FINALIZED_BOOK_INPUT_REQUIRED');
  }
  const adjusted = parseSarToHalalas(adjustedNetResultSar, 'adjustedNetResultSar');
  const book = parseSarToHalalas(finalizedBookResultAfterActualZakatAndTaxSar, 'finalizedBookResultAfterActualZakatAndTaxSar');
  return { differenceHalalas: (adjusted - book).toString() };
}

export type LiabilityPlacementResult = {
  currentLiabilitiesAddedHalalas: ExactHalalas;
  nonCurrentLiabilitiesExcludedHalalas: ExactHalalas;
  nonCurrentLiabilitiesRemainingHalalas: ExactHalalas;
};

/** Individually supported Article 25(2)-(3) allocations; does not resolve aggregate caps or Article 29(2)(b). */
export function calculateArticle25Placement(input: {
  totalCurrentAssetsSar: string;
  deductedCurrentAssetSar: string;
  currentLiabilitiesSar: string;
  totalNonCurrentAssetsSar: string;
  nonDeductedNonCurrentAssetSar: string;
  nonCurrentLiabilitiesSar: string;
}): LiabilityPlacementResult {
  const totalCurrentAssets = parseSarToHalalas(input.totalCurrentAssetsSar, 'totalCurrentAssetsSar');
  const deductedCurrentAsset = parseSarToHalalas(input.deductedCurrentAssetSar, 'deductedCurrentAssetSar');
  const currentLiabilities = parseSarToHalalas(input.currentLiabilitiesSar, 'currentLiabilitiesSar');
  const totalNonCurrentAssets = parseSarToHalalas(input.totalNonCurrentAssetsSar, 'totalNonCurrentAssetsSar');
  const nonDeductedNonCurrentAsset = parseSarToHalalas(input.nonDeductedNonCurrentAssetSar, 'nonDeductedNonCurrentAssetSar');
  const nonCurrentLiabilities = parseSarToHalalas(input.nonCurrentLiabilitiesSar, 'nonCurrentLiabilitiesSar');
  const amounts = [totalCurrentAssets, deductedCurrentAsset, currentLiabilities, totalNonCurrentAssets, nonDeductedNonCurrentAsset, nonCurrentLiabilities];
  if (amounts.some((amount) => amount < 0n)) throw new ZakatInputError('Article 25 amounts cannot be negative', 'NEGATIVE_LIABILITY_PLACEMENT_INPUT');
  if (totalCurrentAssets === 0n || totalNonCurrentAssets === 0n) throw new ZakatInputError('asset totals used as denominators must be positive', 'ZERO_ASSET_DENOMINATOR');
  if (deductedCurrentAsset > totalCurrentAssets || nonDeductedNonCurrentAsset > totalNonCurrentAssets) {
    throw new ZakatInputError('asset amounts cannot exceed their corresponding totals', 'ASSET_AMOUNT_EXCEEDS_TOTAL');
  }

  const currentNumerator = deductedCurrentAsset * currentLiabilities;
  const currentDenominator = totalCurrentAssets;
  const currentCappedNumerator = currentNumerator > deductedCurrentAsset * currentDenominator
    ? deductedCurrentAsset * currentDenominator
    : currentNumerator;

  const nonCurrentNumerator = nonDeductedNonCurrentAsset * nonCurrentLiabilities;
  const nonCurrentDenominator = totalNonCurrentAssets;
  const nonCurrentExcludedNumerator = nonCurrentNumerator > nonDeductedNonCurrentAsset * nonCurrentDenominator
    ? nonDeductedNonCurrentAsset * nonCurrentDenominator
    : nonCurrentNumerator;
  const nonCurrentRemainingNumerator = nonCurrentLiabilities * nonCurrentDenominator - nonCurrentExcludedNumerator;

  return {
    currentLiabilitiesAddedHalalas: fraction(currentCappedNumerator, currentDenominator),
    nonCurrentLiabilitiesExcludedHalalas: fraction(nonCurrentExcludedNumerator, nonCurrentDenominator),
    nonCurrentLiabilitiesRemainingHalalas: fraction(nonCurrentRemainingNumerator, nonCurrentDenominator),
  };
}

/** Fail closed if the requested aggregate result would require the unresolved Article 23/25/29 interaction. */
export function assertAggregateLiabilityResultResolved(input: {
  totalLiabilityAdditionsHalalas: ExactHalalas;
  article29ResidualAdditionHalalas?: ExactHalalas;
  totalDeductedAssetsSar: string;
}): void {
  const cap = parseSarToHalalas(input.totalDeductedAssetsSar, 'totalDeductedAssetsSar');
  if (cap < 0n) throw new ZakatInputError('totalDeductedAssetsSar cannot be negative', 'NEGATIVE_AGGREGATE_CAP');
  const additions = [input.totalLiabilityAdditionsHalalas, input.article29ResidualAdditionHalalas ?? { numerator: '0', denominator: '1' }];
  let totalNumerator = 0n;
  let totalDenominator = 1n;
  for (const amount of additions) {
    if (!amount || !UNSIGNED_INTEGER_PATTERN.test(amount.numerator) || !UNSIGNED_INTEGER_PATTERN.test(amount.denominator) || BigInt(amount.denominator) === 0n) {
      throw new ZakatInputError('liability addition must be a nonnegative exact fraction', 'INVALID_EXACT_AMOUNT');
    }
    const numerator = BigInt(amount.numerator);
    const denominator = BigInt(amount.denominator);
    totalNumerator = totalNumerator * denominator + numerator * totalDenominator;
    totalDenominator *= denominator;
  }
  if (totalNumerator > cap * totalDenominator) {
    throw new ZakatUnresolvedError('liability additions exceed the aggregate deductible-asset cap; sequencing requires professional resolution', 'AGGREGATE_LIABILITY_CAP_UNRESOLVED');
  }
}

/** Article 73 project treatment is deliberately unavailable until applicability and project conditions are resolved. */
export function assertArticle73Interpretable(hasArticle73Activity: boolean): void {
  if (typeof hasArticle73Activity !== 'boolean') throw new ZakatInputError('hasArticle73Activity must be boolean', 'INVALID_ARTICLE_73_SCOPE');
  if (hasArticle73Activity) throw new ZakatUnresolvedError('Article 73 activity requires confirmed applicability and project-specific interpretation', 'ARTICLE_73_INTERPRETATION_REQUIRED');
}
