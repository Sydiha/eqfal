import { MantineProvider } from '@mantine/core';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Banking } from '../components/Banking';
import { PersonalPayments } from '../components/PersonalPayments';
import i18n from '../i18n';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const bankProps = { canView: true, canImport: true, canDeleteImport: false, canManage: false, canMatch: false, canReconcile: false };

describe('common.loading translation', () => {
  it.each(['ar', 'en'])('is defined in %s and never falls back to the raw key', async (lng) => {
    await i18n.changeLanguage(lng);
    const text = i18n.t('common.loading');
    expect(text).not.toBe('common.loading');
    expect(text.length).toBeGreaterThan(3);
  });
});

describe('Bank import error text', () => {
  beforeEach(async () => { await i18n.changeLanguage('ar'); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows the localized fallback, not the raw backend 500 text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Internal server error' }, 500)));
    render(<MantineProvider><Banking {...bankProps} onUnauthorized={vi.fn()} /></MantineProvider>);
    expect(await screen.findByText(i18n.t('banks.error'))).toBeInTheDocument();
    expect(screen.queryByText(/Internal server error/)).toBeNull();
  });

  it('maps 403 to the localized permission message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Forbidden by policy' }, 403)));
    render(<MantineProvider><Banking {...bankProps} onUnauthorized={vi.fn()} /></MantineProvider>);
    expect(await screen.findByText(i18n.t('errors.FORBIDDEN'))).toBeInTheDocument();
    expect(screen.queryByText(/Forbidden by policy/)).toBeNull();
  });

  it('still calls onUnauthorized on 401 and shows no raw text', async () => {
    const onUnauthorized = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'unauthorized' }, 401)));
    render(<MantineProvider><Banking {...bankProps} onUnauthorized={onUnauthorized} /></MantineProvider>);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    expect(screen.queryByText(/unauthorized/i)).toBeNull();
  });
});

describe('Personal payments settlement status cell', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it.each([['en', 'Reimbursement'], ['ar', 'الاسترداد']])('labels the settlement text in %s without changing its value', async (lng, label) => {
    await i18n.changeLanguage(lng);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/lookups')) return json({ payers: [], documents: [], obligations: [], expense_accounts: [] });
      return json({ payments: [{ id: 'p1', payer_id: 'y1', payer_name: 'Manager M', payer_kind: 'employee', treatment: 'new_expense', payment_date: '2026-03-12', accounting_date: '2026-03-12', amount: '500.00', purpose: 'Hotel', document_id: null, obligation_id: null, expense_account_id: null, counterparty_id: null, status: 'approved', rejection_reason: null, version: 1, reimbursed_amount: '0.00', outstanding_amount: '500.00', settlement_status: 'none' }] });
    }));
    render(<PersonalPayments capabilities={['personal_payment.view']} onUnauthorized={vi.fn()} />);
    const row = (await screen.findByText('Hotel')).closest('tr')!;
    const small = row.querySelector('.pp-status small')!;
    expect(small.getAttribute('data-label')).toBe(label);
    expect(small.textContent?.trim()).toBe((lng === 'en' ? 'Not reimbursed' : 'غير مستردة'));
    expect(row.querySelector('td[data-label] > .pp-status')).not.toBeNull();
  });
});
