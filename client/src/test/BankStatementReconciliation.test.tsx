import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { BankStatementReconciliation } from '../components/BankStatementReconciliation';

const BANK = { id: '11111111-1111-4111-8111-111111111111', display_name: 'Main', currency_code: 'SAR', is_active: true };
const statement = (id: string, status: string, ref: string) => ({ id, bank_account_id: BANK.id, statement_ref: ref, period_start: '2026-01-01', period_end: '2026-01-31', opening_balance: '0.00', closing_balance: '1000.00', status, version: 1, replacement_reason: status === 'confirmed' ? 'Bank correction' : null, currency_code: 'SAR' });
const calc = (over: Record<string, unknown> = {}) => ({
  mode: 'enforce', effective_mode: 'enforce',
  accounts: [{ ledger_account_id: 'l', statement_ref: 'S', statement_closing_balance: '1000.00', gl_balance: '750.00', deposits_in_transit: '0.00', outstanding_payments: '250.00', adjusted_bank_balance: '750.00',
    adjusted_gl_balance: '750.00', difference: '0.00', outstanding_items: [{ journal_entry_id: 'j', accounting_date: '2026-01-31', bank_transaction_id: 'b', bank_transaction_date: '2026-02-20', kind: 'outstanding_payment', amount: '250.00', days_after_period_end: 20, aged: true }],
    rejected_evidence: [], bank_only_count: 0, problems: [], warnings: ['outstanding_aged'], reconciled: true, ...over }],
});

function mockApi(settings: Record<string, unknown>, evaluation: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url.startsWith('/api/bank-accounts') ? { accounts: [BANK] }
      : url.startsWith('/api/bank-statements') ? [statement('s1', 'draft', 'DRAFT-1'), statement('s2', 'confirmed', 'CONF-1'), statement('s3', 'superseded', 'OLD-1')]
      : url.startsWith('/api/bank-ledger-links') ? []
      : url.startsWith('/api/bank-reconciliation/settings') ? settings
      : url.startsWith('/api/bank-reconciliation/preview') ? evaluation
      : { accounts: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
}
const renderIt = (props: Partial<React.ComponentProps<typeof BankStatementReconciliation>> = {}) => render(<MantineProvider><BankStatementReconciliation
  canView canManageStatements={false} canConfirmStatements={false} canManageSettings={false} canManageLinks={false} onUnauthorized={vi.fn()} {...props}/></MantineProvider>);

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('BankStatementReconciliation', () => {
  it('does not request data without bank.view', () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    renderIt({ canView: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows draft, confirmed and superseded states, the evidenced items and a zero difference, with mutation controls hidden', async () => {
    mockApi({ mode: 'warn', enforce_from: null, version: 1 }, calc());
    renderIt();
    expect(await screen.findByText('Draft')).toBeTruthy();
    expect(screen.getByText('Confirmed')).toBeTruthy();
    expect(screen.getByText('Superseded')).toBeTruthy();
    expect(await screen.findByText('Reconciled')).toBeTruthy();
    expect(screen.getByText('Outstanding payment')).toBeTruthy();
    expect(screen.getByText('An outstanding item is older than 10 days')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('labels an unexplained difference as a blocker when enforced and as a warning when only warned', async () => {
    mockApi({ mode: 'enforce', enforce_from: '2000-01-01', version: 2 }, calc({ difference: '250.00', problems: ['difference_unexplained'], reconciled: false, warnings: [] }));
    const { unmount } = renderIt();
    await waitFor(() => expect(screen.getAllByText('Blocker').length).toBeGreaterThan(0));
    expect(screen.getByText('Difference is not explained by evidenced items')).toBeTruthy();
    unmount();
    mockApi({ mode: 'warn', enforce_from: null, version: 2 }, calc({ difference: '250.00', problems: ['difference_unexplained'], reconciled: false, warnings: [] }));
    renderIt();
    await waitFor(() => expect(screen.getAllByText('Warning').length).toBeGreaterThan(0));
    expect(screen.queryByText('Blocker')).toBeNull();
  });

  it('offers confirm, replace and settings controls only to holders of the matching capability', async () => {
    mockApi({ mode: 'off', enforce_from: null, version: 0 }, calc());
    renderIt({ canManageStatements: true, canConfirmStatements: true, canManageSettings: true });
    expect(await screen.findByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('validates the statement form with localized messages instead of browser or backend text, in English and Arabic', async () => {
    mockApi({ mode: 'off', enforce_from: null, version: 0 }, calc());
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const { unmount } = renderIt({ canManageStatements: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Save draft' }));
    expect((await screen.findAllByText('This field is required')).length).toBeGreaterThanOrEqual(3);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    fireEvent.change(document.querySelector('input[name="closing"]')!, { target: { value: '12.345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Enter a valid amount with at most two decimals')).toBeTruthy();
    unmount();
    await i18n.changeLanguage('ar');
    mockApi({ mode: 'off', enforce_from: null, version: 0 }, calc());
    const ui = renderIt({ canManageStatements: true });
    fireEvent.click(await screen.findByRole('button', { name: 'حفظ كمسودة' }));
    expect((await screen.findAllByText('هذا الحقل مطلوب')).length).toBeGreaterThanOrEqual(3);
    expect(ui.container.querySelector('.bank-statement-reconciliation')?.getAttribute('dir')).toBe('rtl');
    expect(document.querySelector('input[name="closing"]')?.getAttribute('dir')).toBe('ltr');
  });

  it('requires an effective date before enforcing and localizes the message', async () => {
    mockApi({ mode: 'off', enforce_from: null, version: 0 }, calc());
    renderIt({ canManageSettings: true });
    const select = (await screen.findAllByRole('combobox'))[0]!;
    fireEvent.change(select, { target: { value: 'enforce' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This field is required')).toBeTruthy();
  });

  it('asks for confirmation in the app dialog (not a browser dialog) and only confirms after the user agrees', async () => {
    mockApi({ mode: 'off', enforce_from: null, version: 0 }, calc());
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderIt({ canConfirmStatements: true, canManageStatements: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Confirm this statement balance? Confirmed values cannot be edited.')).toBeTruthy();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some(([u, init]) => String(u).endsWith('/confirm') && (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/confirm'))).toBe(false);
  });

  it.each([
    ['en', 'BANK_STATEMENT_STALE', 'This statement balance was changed by someone else. Reload and try again.'],
    ['ar', 'BANK_STATEMENT_DUPLICATE_PERIOD', 'يوجد رصيد كشف معتمد لهذا الحساب البنكي ولنهاية الفترة نفسها.'],
  ] as const)('shows the localized %s message for backend code %s, never the raw backend text', async (lang, code, message) => {
    await i18n.changeLanguage(lang);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ error: 'raw backend english text', code }), { status: 409 });
      const body = url.startsWith('/api/bank-accounts') ? { accounts: [BANK] } : url.startsWith('/api/bank-statements') ? [statement('s1', 'draft', 'DRAFT-1')]
        : url.startsWith('/api/bank-reconciliation/settings') ? { mode: 'off', enforce_from: null, version: 0 } : url.startsWith('/api/bank-reconciliation/preview') ? calc() : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    renderIt({ canConfirmStatements: true });
    fireEvent.click(await screen.findByRole('button', { name: lang === 'ar' ? 'اعتماد' : 'Confirm' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: lang === 'ar' ? 'اعتماد' : 'Confirm' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText('raw backend english text')).toBeNull();
  });
});
