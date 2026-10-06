import { describe, expect, it } from 'vitest';
import { ApplicabilityProfile, evaluateProfileApplicability } from '../src/modules/fiscal-years/fiscal-year-close-readiness';

const p = (o: Partial<ApplicabilityProfile>): ApplicabilityProfile => ({
  effective_from: '2025-01-01', effective_to: null, version_no: 1, vat_status: 'not_registered',
  vat_registered_from: null, vat_deregistered_from: null, first_live_accounting_date: '2025-01-01', ...o,
});
const Y: [string, string] = ['2026-01-01', '2026-12-31'];

describe('evaluateProfileApplicability', () => {
  it('single full-year registered profile: VAT applicable, no resolution needed', () => {
    expect(evaluateProfileApplicability([p({ vat_status: 'registered', vat_registered_from: '2025-01-01' })], ...Y))
      .toMatchObject({ vatApplicable: true, vatRequiresResolution: false });
  });
  it('single not-registered profile: not applicable', () => {
    expect(evaluateProfileApplicability([p({})], ...Y)).toMatchObject({ vatApplicable: false, vatRequiresResolution: false });
  });
  it('registration after year end is not applicable; deregistered before year start is not applicable', () => {
    expect(evaluateProfileApplicability([p({ vat_status: 'registered', vat_registered_from: '2027-01-01' })], ...Y).vatApplicable).toBe(false);
    expect(evaluateProfileApplicability([p({ vat_status: 'deregistered', vat_registered_from: '2024-01-01', vat_deregistered_from: '2025-12-31' })], ...Y).vatApplicable).toBe(false);
    expect(evaluateProfileApplicability([p({ vat_status: 'deregistered', vat_registered_from: '2024-01-01', vat_deregistered_from: '2026-03-01' })], ...Y).vatApplicable).toBe(true);
  });
  it('needs_review is a warning only and does not suppress a known applicable version', () => {
    const r = evaluateProfileApplicability([
      p({ effective_from: '2026-07-01', version_no: 2, vat_status: 'needs_review' }),
      p({ effective_to: '2026-06-30', vat_status: 'registered', vat_registered_from: '2025-01-01' }),
    ], ...Y);
    expect(r).toMatchObject({ vatApplicable: true, vatRequiresResolution: true });
  });
  it('no profile: unknown VAT (warning), opening balances keep the Monthly Close default', () => {
    expect(evaluateProfileApplicability([], ...Y)).toEqual({ vatApplicable: false, vatRequiresResolution: true, openingApplicable: true });
  });
  it('opening balances follow the latest version first_live date', () => {
    expect(evaluateProfileApplicability([p({ first_live_accounting_date: '2026-03-01' })], ...Y).openingApplicable).toBe(true);
    expect(evaluateProfileApplicability([p({ first_live_accounting_date: '2025-01-01' })], ...Y).openingApplicable).toBe(false);
  });
});
