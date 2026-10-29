import { render, screen, waitFor } from '@testing-library/react';
import { render as renderWithProviders } from './test-utils';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { screenErrorMessage, ApiError } from '../api/apiError';
import { SettlementPanel } from '../components/SettlementPanel';
import { BankTransactionsView } from '../components/BankTransactionsView';
import { AnnualClosing } from '../components/AnnualClosing';

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
const NEW_CODES = ['OPENING_BALANCE_RECONCILIATION_BLOCKED', 'OPENING_BALANCE_EXCEPTIONS_REQUIRED', 'OPENING_BALANCE_MANUAL_JOURNAL_BLOCKED', 'OPENING_BALANCE_REVIEW_CONTEXT_INVALID', 'CARRYFORWARD_RECONCILIATION_MISMATCH', 'LEDGER_SOURCE_AUTHORITY_BLOCKED'];

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

describe('screenErrorMessage', () => {
  it.each(['en', 'ar'])('maps known codes in %s and hides unknown ones', async (lang) => {
    await i18n.changeLanguage(lang);
    const t = i18n.t.bind(i18n);
    for (const code of [...NEW_CODES, 'ACCOUNTING_PERIOD_CLOSED', 'FISCAL_YEAR_CLOSED']) {
      const text = screenErrorMessage(new ApiError({ status: 409, code, message: 'RAW' }), t, 'FALLBACK');
      expect(text).not.toBe('FALLBACK'); expect(text).not.toBe('RAW'); expect(text).not.toMatch(/^errors\./);
      if (lang === 'ar') expect(text).toMatch(/[؀-ۿ]/);
    }
    expect(screenErrorMessage(new ApiError({ status: 409, code: 'SOMETHING_NEW', message: 'RAW' }), t, 'FALLBACK')).toBe('FALLBACK');
    expect(screenErrorMessage(new ApiError({ status: 409, message: 'RAW' }), t, 'FALLBACK')).toBe('FALLBACK');
    expect(screenErrorMessage(new ApiError({ status: 403, message: 'Forbidden' }), t, 'FALLBACK')).toBe(t('errors.FORBIDDEN'));
    expect(screenErrorMessage(new ApiError({ status: 503 }), t, 'FALLBACK')).toBe(t('errors.DB_UNAVAILABLE'));
    expect(screenErrorMessage(new TypeError('Failed to fetch'), t, 'FALLBACK')).toBe(t('errors.NETWORK_ERROR'));
    expect(screenErrorMessage(new ApiError({ status: 401 }), t, 'FALLBACK')).toBe('');
  });
});

describe('SettlementPanel errors', () => {
  const panel = () => render(<MantineProvider><SettlementPanel canView canSettle onUnauthorized={vi.fn()} /></MantineProvider>);
  it('shows a localized message and not the raw server text when loading fails', async () => {
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Database unavailable raw' }, 503)));
    panel();
    expect(await screen.findByRole('alert')).toHaveTextContent('الخدمة غير متاحة');
    expect(screen.queryByText(/raw/)).not.toBeInTheDocument();
  });
  it('uses the screen fallback for an unknown 409 without guessing a reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Some English reason' }, 409)));
    panel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load payment settlements');
    expect(screen.queryByText('Some English reason')).not.toBeInTheDocument();
  });
});

describe('BankTransactionsView errors', () => {
  it.each([[403, 'You do not have permission'], [503, 'temporarily unavailable']])('localizes a %s load failure', async (status, text) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'RAW BACKEND' }, status)));
    render(<MantineProvider><BankTransactionsView canView canMatch canReconcile onUnauthorized={vi.fn()} /></MantineProvider>);
    await waitFor(() => expect(screen.getByText(new RegExp(text))).toBeInTheDocument());
    expect(screen.queryByText(/RAW BACKEND/)).not.toBeInTheDocument();
  });
  it('shows a network message when the request cannot reach the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<MantineProvider><BankTransactionsView canView canMatch canReconcile onUnauthorized={vi.fn()} /></MantineProvider>);
    await waitFor(() => expect(screen.getByText(/Could not connect to the server/)).toBeInTheDocument());
  });
});

describe('AnnualClosing errors', () => {
  it('localizes a readiness load failure without raw backend text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (u: string) => u === '/api/fiscal-years' ? json({ fiscalYears: [{ id: '11111111-1111-4111-8111-111111111111', name: 'FY', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' }] }, 200) : json({ error: 'RAW BACKEND' }, 503)));
    renderWithProviders(<AnnualClosing canView onUnauthorized={vi.fn()} />);
    expect(await screen.findByText(/temporarily unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/RAW BACKEND/)).not.toBeInTheDocument();
  });
});
