import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18n from '../i18n';
import { ApiError, screenErrorMessage } from '../api/apiError';

// Every code PR-2B added on the server (exact list, checked against the server sources below).
const PR2B_CODES = [
  'OBLIGATION_SETTLEMENT_DOCUMENT_SOURCED', 'OBLIGATION_CANCELLED', 'OBLIGATION_NOT_POSTED', 'OBLIGATION_BANK_DIRECTION_MISMATCH',
  'OBLIGATION_SETTLEMENT_AMOUNT_MISMATCH', 'BANK_TRANSACTION_ALREADY_LINKED', 'OBLIGATION_SETTLEMENT_EXCEEDS_REMAINING',
  'BANK_TRANSACTION_ALREADY_MATCHED', 'BANK_DIRECTION_INCOMPATIBLE', 'DOCUMENT_NOT_ELIGIBLE_FOR_MATCHING', 'DOCUMENT_NOT_APPROVED',
  'DOCUMENT_TOTAL_REQUIRED', 'BANK_ALLOCATION_COUNTERPARTY_MISMATCH', 'BANK_ALLOCATION_EXCEEDS_AMOUNT', 'BANK_ALLOCATION_EXCEEDS_LIMIT',
  'BANK_TRANSACTION_NOT_MATCHED', 'BANK_TRANSACTION_NOT_FULLY_ALLOCATED', 'BANK_RECONCILIATION_REOPEN_REQUIRED',
  'BANK_SETTLEMENT_DELETE_REQUIRED', 'BANK_TRANSACTION_CUSTODY_MANAGED', 'BANK_RECONCILIATION_INVALID_TRANSITION',
  'BANK_TRANSACTION_ALREADY_SETTLED', 'SETTLEMENT_LIMIT_EXCEEDED', 'SETTLEMENT_EXCEEDS_BANK_UNALLOCATED',
  'SETTLEMENT_EXCEEDS_DOCUMENT_REMAINING', 'SETTLEMENT_EXCEEDS_OBLIGATION_REMAINING', 'OB_ITEMS_NOT_EDITABLE', 'OB_REVIEW_NOT_DRAFT',
  'OB_REVIEW_NOT_IN_REVIEW', 'OB_JOURNAL_ALREADY_EXISTS', 'OB_ITEM_STALE', 'ANNUAL_PACKAGE_ALREADY_EXISTS', 'ANNUAL_PACKAGE_STALE_VERSION',
  'ANNUAL_PACKAGE_NOT_DRAFT', 'ANNUAL_PACKAGE_NOT_FINALIZED', 'ANNUAL_PACKAGE_INVALID_TRANSITION',
  'ANNUAL_PACKAGE_CHANGED_AFTER_FINALIZATION', 'ANNUAL_PACKAGE_SNAPSHOT_UNAVAILABLE',
];

beforeEach(async () => { await i18n.changeLanguage('en'); });

describe('PR-2B server codes map to actionable AR/EN messages', () => {
  it.each(['en', 'ar'])('maps every PR-2B code in %s without raw backend text', async (lang) => {
    await i18n.changeLanguage(lang);
    const t = i18n.t.bind(i18n);
    for (const code of PR2B_CODES) {
      const text = screenErrorMessage(new ApiError({ status: 409, code, message: 'RAW SERVER TEXT' }), t, 'FALLBACK');
      expect(text, code).not.toBe('FALLBACK'); expect(text, code).not.toBe('RAW SERVER TEXT'); expect(text, code).not.toMatch(/^errors\./);
      if (lang === 'ar') expect(text, code).toMatch(/[؀-ۿ]/);
    }
  });

  it('keeps the localized fallback for unknown or missing codes and for requireAll FORBIDDEN', async () => {
    const t = i18n.t.bind(i18n);
    expect(screenErrorMessage(new ApiError({ status: 409, code: 'NOT_A_REAL_CODE', message: 'RAW' }), t, 'FALLBACK')).toBe('FALLBACK');
    expect(screenErrorMessage(new ApiError({ status: 409, message: 'Conflict' }), t, 'FALLBACK')).toBe('FALLBACK');
    expect(screenErrorMessage(new ApiError({ status: 403, code: 'FORBIDDEN', message: 'Forbidden' }), t, 'FALLBACK')).toBe(t('errors.FORBIDDEN'));
  });

  it('only lists codes that the server sources actually emit', () => {
    const root = resolve(process.cwd(), '../server/src/modules');
    const sources = ['banking/banking-error-codes.ts', 'obligations/obligation.router.ts', 'opening-balances/opening-balances.router.ts', 'annual-closing/annual-closing.router.ts']
      .map((f) => readFileSync(resolve(root, f), 'utf8')).join('\n');
    for (const code of PR2B_CODES) expect(sources, code).toContain(`'${code}'`);
  });
});
