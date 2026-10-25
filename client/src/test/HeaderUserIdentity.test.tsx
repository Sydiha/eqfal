import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { headerRoleLabel } from '../App';
import { AuthProvider, type AuthSession } from '../context/AuthContext';
import i18n from '../i18n';

const companies = [{ id: 'co-a', name: 'Alpha', name_ar: 'ألفا' }, { id: 'co-b', name: 'Beta', name_ar: 'بيتا' }];
const session = (over: Partial<AuthSession> & { displayName?: string | null } = {}): AuthSession => ({
  user: { id: 'u1', email: 'staff@example.test', displayName: over.displayName === undefined ? 'سارة أحمد' : over.displayName, isSystemAdmin: false, mustChangePassword: false, ...over.user },
  allowedCompanies: companies,
  activeCompanyId: 'co-a',
  activeRole: { name: 'Accountant', isFullAccess: false },
  capabilities: [],
  ...over,
});

let current: AuthSession;
let switched: AuthSession;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/auth/session')) return new Response(JSON.stringify(current), { status: 200 });
    if (url.includes('/api/auth/switch-company')) { current = switched; return new Response(JSON.stringify(switched), { status: 200 }); }
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
  }));
});
afterEach(async () => { await act(async () => { await i18n.changeLanguage('ar'); }); vi.unstubAllGlobals(); });

const header = async () => {
  render(<AuthProvider><App /></AuthProvider>);
  return within(await screen.findByRole('button', { name: i18n.t('nav.account') }));
};

describe('header user identity', () => {
  it('shows the stored name, the localized active-company role and the email (Arabic RTL)', async () => {
    await act(async () => { await i18n.changeLanguage('ar'); });
    current = session();
    const box = await header();
    expect(box.getByText('سارة أحمد')).toBeTruthy();
    expect(box.getByText('محاسب')).toBeTruthy();
    expect(box.getByText('staff@example.test').getAttribute('dir')).toBe('ltr');
    expect(box.queryByText('المستخدم الحالي')).toBeNull();
  });

  it('falls back to the email when there is no name and never derives one (English LTR)', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    current = session({ displayName: null });
    const box = await header();
    expect(box.getAllByText('staff@example.test')).toHaveLength(1);
    expect(box.queryByText(/^staff$/i)).toBeNull();
    expect(box.getByText('Accountant')).toBeTruthy();
  });

  it('refreshes the role when switching companies', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    current = session();
    switched = session({ activeCompanyId: 'co-b', activeRole: { name: 'Viewer', isFullAccess: false } });
    const box = await header();
    expect(box.getByText('Accountant')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(i18n.t('company.switchAriaLabel')), { target: { value: 'co-b' } });
    await waitFor(() => expect(box.getByText('Viewer')).toBeTruthy());
  });
});

describe('header after a session refresh', () => {
  it('shows an edited name once the session is re-read', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    current = session({ activeRole: { name: 'Full Access', isFullAccess: true }, capabilities: ['access.view'] });
    const box = await header();
    expect(box.getByText('سارة أحمد')).toBeTruthy();
    current = session({ displayName: 'Sara Ahmed', activeRole: { name: 'Full Access', isFullAccess: true }, capabilities: ['access.view'] });
    // Switching company re-reads the session the same way refreshSession does after an access change.
    switched = current;
    fireEvent.change(screen.getByLabelText(i18n.t('company.switchAriaLabel')), { target: { value: 'co-b' } });
    await waitFor(() => expect(box.getByText('Sara Ahmed')).toBeTruthy());
  });
});

describe('headerRoleLabel', () => {
  const t = i18n.t.bind(i18n);
  it('labels a System Admin regardless of membership', async () => {
    await act(async () => { await i18n.changeLanguage('ar'); });
    expect(headerRoleLabel(session({ user: { id: 'u', email: 'a@b.c', isSystemAdmin: true }, activeRole: null }), t)).toBe('مدير النظام');
    await act(async () => { await i18n.changeLanguage('en'); });
    expect(headerRoleLabel(session({ user: { id: 'u', email: 'a@b.c', isSystemAdmin: true }, activeRole: { name: 'Viewer', isFullAccess: false } }), t)).toBe('System Admin');
  });
  it('shows custom role names as stored and a clear label when there is no role', async () => {
    await act(async () => { await i18n.changeLanguage('en'); });
    expect(headerRoleLabel(session({ activeRole: { name: 'Payroll Clerk', isFullAccess: false } }), t)).toBe('Payroll Clerk');
    expect(headerRoleLabel(session({ activeRole: null }), t)).toBe('No role');
  });
});
