import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';
import { FiscalYears } from '../components/FiscalYears';
import { Accounting } from '../components/Accounting';
import ar from '../i18n/locales/ar';
import en from '../i18n/locales/en';
import {
  FISCAL_YEAR_BLOCKER_CODES, FISCAL_YEAR_WARNING_CODES, PHASE1_ERROR_CODES, PHASE2_ERROR_CODES, parseApiError,
} from '../api/apiError';

const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const openYear = { id: 'fy-1', name: 'FY 2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' as const };

beforeEach(async () => {
  await i18n.changeLanguage('en');
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('apiError parser', () => {
  it('parses code, blockers, warnings and tolerates non-JSON proxy bodies', async () => {
    const parsed = await parseApiError(jsonResponse({ error: 'x', code: 'FISCAL_YEAR_CLOSE_BLOCKED', blockers: [{ code: 'draft_journals', count: 2 }], warnings: [{ code: 'vat_boundary_review', count: 1, detail: 'hidden' }] }, 409));
    expect(parsed.status).toBe(409);
    expect(parsed.code).toBe('FISCAL_YEAR_CLOSE_BLOCKED');
    expect(parsed.blockers).toEqual([{ code: 'draft_journals', count: 2 }]);
    expect(parsed.warnings).toEqual([{ code: 'vat_boundary_review', count: 1, detail: 'hidden' }]);

    const html = await parseApiError(new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    expect(html.status).toBe(502);
    expect(html.code).toBeNull();
    const empty = await parseApiError(new Response(null, { status: 500 }));
    expect(empty.code).toBeNull();
  });
});

describe('translation contract', () => {
  it.each([['en', en], ['ar', ar]] as const)('%s has every Phase 1 code, blocker and warning', (_lang, bundle) => {
    const errors = bundle.errors as Record<string, unknown>;
    for (const code of [...PHASE1_ERROR_CODES, ...PHASE2_ERROR_CODES]) expect(typeof errors[code], code).toBe('string');
    const blockers = errors.blockers as Record<string, string>;
    const warnings = errors.warnings as Record<string, string>;
    for (const code of FISCAL_YEAR_BLOCKER_CODES) expect(typeof blockers[code], code).toBe('string');
    for (const code of FISCAL_YEAR_WARNING_CODES) expect(typeof warnings[code], code).toBe('string');
  });
});

describe('FiscalYears coded errors', () => {
  const setup = (failure: Response) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ fiscalYears: [openYear] }, 200))
      .mockResolvedValueOnce(failure);
    vi.stubGlobal('fetch', fetchMock);
    render(<FiscalYears canView canCreate canEdit canClose onUnauthorized={vi.fn()} />);
  };

  it('blocked close keeps the dialog open and lists translated blockers and warnings, not "conflict"', async () => {
    setup(jsonResponse({
      error: 'Fiscal year close blocked', code: 'FISCAL_YEAR_CLOSE_BLOCKED',
      blockers: [{ code: 'draft_journals', count: 3 }, { code: 'trial_balance_unbalanced', count: 1 }],
      warnings: [{ code: 'zakat_tax_workpaper_not_ready', count: 1 }],
    }, 409));
    await screen.findByText('FY 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm close' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The fiscal year cannot be closed until the following blockers are resolved.');
    expect(alert).toHaveTextContent('Draft journals not posted (3).');
    expect(alert).toHaveTextContent('The trial balance is not balanced.');
    expect(alert).toHaveTextContent('The Zakat/tax workpaper is not ready.');
    expect(alert).not.toHaveTextContent(/conflicts with an existing year|Fiscal year close blocked/);
    expect(screen.getByRole('button', { name: 'Confirm close' })).toBeInTheDocument();
  });

  it('blocked close renders Arabic blockers', async () => {
    await i18n.changeLanguage('ar');
    setup(jsonResponse({ error: 'Fiscal year close blocked', code: 'FISCAL_YEAR_CLOSE_BLOCKED', blockers: [{ code: 'monthly_period_open', count: 2 }], warnings: [] }, 409));
    await screen.findByText('FY 2026');
    fireEvent.click(screen.getByRole('button', { name: 'إقفال' }));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإقفال' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('لا يمكن إقفال السنة المالية قبل معالجة المعوقات التالية.');
    expect(alert).toHaveTextContent('فترات شهرية لم يتم إقفالها (2).');
  });

  it('overlap still shows the overlap message', async () => {
    setup(jsonResponse({ error: 'Fiscal year state conflict', code: 'FISCAL_YEAR_OVERLAP' }, 409));
    await screen.findByText('FY 2026');
    fireEvent.click(screen.getByText('Create fiscal year'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'FY 2026b' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-05-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This fiscal year overlaps another fiscal year.');
  });

  it('shows the select-company message for NO_ACTIVE_COMPANY', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'No active company', code: 'NO_ACTIVE_COMPANY' }, 403)));
    render(<FiscalYears canView canCreate={false} canEdit={false} canClose={false} onUnauthorized={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Select a company before continuing.');
    await i18n.changeLanguage('ar');
  });
});

describe('Accounting posting coded errors', () => {
  const journal = { id: '22222222-2222-4222-8222-222222222222', fiscal_year_id: '33333333-3333-4333-8333-333333333333', accounting_date: '2026-09-10', description: 'Closed posting', reference: null, entry_type: 'standard' as const, status: 'draft' as const };
  const accounts = [
    { id: '11111111-1111-4111-8111-111111111111', code: '1100', name: 'Cash', account_type: 'asset' as const, parent_account_id: null, is_active: true },
    { id: '44444444-4444-4444-8444-444444444444', code: '2100', name: 'Payable', account_type: 'liability' as const, parent_account_id: null, is_active: true },
  ];
  const lines = [
    { id: 'l1', company_id: 'c', journal_entry_id: journal.id, account_id: accounts[0]!.id, debit: '150.00', credit: '0.00', memo: null, sequence: 1 },
    { id: 'l2', company_id: 'c', journal_entry_id: journal.id, account_id: accounts[1]!.id, debit: '0.00', credit: '150.00', memo: null, sequence: 2 },
  ];

  it.each([
    ['FISCAL_YEAR_CLOSED', 'Posting is not allowed because the fiscal year is closed.'],
    ['ACCOUNTING_PERIOD_CLOSED', 'This action is not allowed because the accounting period is closed.'],
    ['NO_ACTIVE_COMPANY', 'Select a company before continuing.'],
  ])('post failing with %s shows its message, keeps the draft open', async (code, message) => {
    window.history.replaceState(null, '', '/?page=accounting');
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET';
      if (url === '/api/accounts') return jsonResponse({ accounts }, 200);
      if (url === '/api/fiscal-years') return jsonResponse({ fiscalYears: [{ id: journal.fiscal_year_id, name: '2026', start_date: '2026-01-01', end_date: '2026-12-31' }] }, 200);
      if (url === '/api/journals' && method === 'GET') return jsonResponse({ journals: [journal] }, 200);
      if (url === '/api/accounting/operational-sources') return jsonResponse({ sources: [] }, 200);
      if (url === `/api/journals/${journal.id}` && method === 'GET') return jsonResponse({ ...journal, lines }, 200);
      if (url === `/api/journals/${journal.id}/post`) return jsonResponse({ error: 'raw backend english', code }, code === 'NO_ACTIVE_COMPANY' ? 403 : 409);
      throw new Error(`${method} ${url}`);
    }));
    render(<Accounting canView canCreateChart={false} canEditChart={false} canCreateJournal canEditJournal canPost onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Journals' }));
    fireEvent.click(await screen.findByRole('button', { name: /Closed posting/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Post journal' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/raw backend english/)).not.toBeInTheDocument();
    expect(screen.getByText('Closed posting', { selector: 'h3' })).toBeInTheDocument();
  });
});

describe('Login error differentiation', () => {
  const loginWith = async (loginResponse: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/session') return new Response(null, { status: 401 });
      if (url === '/api/auth/login') return loginResponse();
      throw new Error(url);
    }));
    render(<AuthProvider><App /></AuthProvider>);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    return screen.findByRole('alert');
  };

  it('401 shows the credentials message', async () => {
    const alert = await loginWith(async () => jsonResponse({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' }, 401));
    expect(alert).toHaveTextContent('The email or password is incorrect.');
  });

  it('503 shows service unavailable and never blames the password', async () => {
    const alert = await loginWith(async () => jsonResponse({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }, 503));
    expect(alert).toHaveTextContent('The service is temporarily unavailable. Please try again shortly.');
    expect(alert).not.toHaveTextContent(/password/i);
  });

  it('network failure shows the connection error', async () => {
    const alert = await loginWith(async () => { throw new TypeError('Failed to fetch'); });
    expect(alert).toHaveTextContent('Could not connect to the server. Check your connection and try again.');
    expect(alert).not.toHaveTextContent(/password/i);
  });

  it('400 and 403-origin show their own messages', async () => {
    const bad = await loginWith(async () => jsonResponse({ error: 'Invalid login request', code: 'INVALID_LOGIN_REQUEST' }, 400));
    expect(bad).toHaveTextContent('Check the login details and try again.');
  });

  it('403 origin shows the refresh message', async () => {
    const origin = await loginWith(async () => jsonResponse({ error: 'Invalid request origin', code: 'INVALID_REQUEST_ORIGIN' }, 403));
    expect(origin).toHaveTextContent('Refresh and try again.');
  });
});
