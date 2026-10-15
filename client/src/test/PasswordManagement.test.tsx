import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { PASSWORD_ERROR_CODES } from '../api/apiError';
import { AccessAdministration } from '../components/AccessAdministration';
import { AccountSettings, RequiredPasswordChange } from '../components/AccountSettings';
import { AuthProvider } from '../context/AuthContext';
import { canShowNavigationPage } from '../components/navigationVisibility';
import { labelFor } from './helpers/passwordLabels';

const session = (mustChangePassword = false) => ({ user: { id: 'u-1', email: 'me@example.com', isSystemAdmin: false, mustChangePassword }, allowedCompanies: [], activeCompanyId: null, capabilities: [] });

function mockAuthApi(options: { sessionBody: object; change?: (body: Record<string, string>) => Response }) {
  const calls: { url: string; body?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    if (url === '/api/auth/session') return new Response(JSON.stringify(options.sessionBody), { status: 200 });
    if (url === '/api/auth/change-password') return options.change!(JSON.parse(init!.body as string));
    return new Response('{}', { status: 200 });
  }));
  return calls;
}
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });
afterEach(cleanup);

describe('Account Settings password change', () => {
  it('requires matching confirmation before calling the server', async () => {
    const calls = mockAuthApi({ sessionBody: session() });
    render(<AuthProvider><AccountSettings /></AuthProvider>);
    fill('Current password', 'OldPassw0rd!'); fill('New password', 'Brand-new-pass-1'); fill('Confirm new password', 'different-pass-9');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    expect(calls.some((c) => c.url === '/api/auth/change-password')).toBe(false);
  });

  it('sends only the two passwords, shows success and clears the fields', async () => {
    const calls = mockAuthApi({ sessionBody: session(), change: () => new Response(JSON.stringify(session()), { status: 200 }) });
    render(<AuthProvider><AccountSettings /></AuthProvider>);
    fill('Current password', 'OldPassw0rd!'); fill('New password', 'Brand-new-pass-1'); fill('Confirm new password', 'Brand-new-pass-1');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed');
    expect(JSON.parse(calls.find((c) => c.url === '/api/auth/change-password')!.body!)).toEqual({ currentPassword: 'OldPassw0rd!', newPassword: 'Brand-new-pass-1' });
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('');
  });

  it('shows a clear message for a wrong current password in Arabic and English', async () => {
    mockAuthApi({ sessionBody: session(), change: () => new Response(JSON.stringify({ error: 'x', code: 'INVALID_CURRENT_PASSWORD' }), { status: 400 }) });
    render(<AuthProvider><AccountSettings /></AuthProvider>);
    fill('Current password', 'wrong-pass-1'); fill('New password', 'Brand-new-pass-1'); fill('Confirm new password', 'Brand-new-pass-1');
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('current password is incorrect');
    expect(labelFor('ar', 'errors.INVALID_CURRENT_PASSWORD')).toContain('غير صحيحة');
  });
});

describe('required password change screen', () => {
  it('explains the temporary password and offers sign out', async () => {
    mockAuthApi({ sessionBody: session(true) });
    render(<AuthProvider><RequiredPasswordChange /></AuthProvider>);
    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument();
    expect(screen.getByText(/administrator reset your password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});

describe('translations and navigation', () => {
  it('has distinct AR and EN text for every password error code', async () => {
    for (const code of PASSWORD_ERROR_CODES) {
      const en = labelFor('en', `errors.${code}`); const ar = labelFor('ar', `errors.${code}`);
      expect(en, code).not.toBe(`errors.${code}`); expect(ar, code).not.toBe(`errors.${code}`); expect(ar).not.toBe(en);
    }
  });
  it('shows the account page to every signed-in user', () => expect(canShowNavigationPage('account', [])).toBe(true));
});

describe('administrative reset in Users & Permissions', () => {
  const members = [
    { id: 'm-1', user_id: 'u-1', user_email: 'me@example.com', user_is_active: true, role_id: 'r', role_name: 'Owner', is_active: true },
    { id: 'm-2', user_id: 'u-2', user_email: 'clerk@example.com', user_is_active: true, role_id: 'r2', role_name: 'Clerk', is_active: true },
    { id: 'm-3', user_id: 'u-3', user_email: 'boss@example.com', user_is_active: true, role_id: 'r', role_name: 'Owner', is_active: true, can_manage: false },
  ];
  function mockAccess(resetResponse: Response) {
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/access/memberships' && !init?.method) return new Response(JSON.stringify({ memberships: members }), { status: 200 });
      if (url === '/api/access/roles') return new Response(JSON.stringify({ roles: [] }), { status: 200 });
      if (url === '/api/access/capabilities') return new Response(JSON.stringify({ capabilities: [], sensitivity: {} }), { status: 200 });
      if (url.endsWith('/reset-password')) return resetResponse;
      return new Response('{}', { status: 200 });
    }));
    return calls;
  }
  const caps = ['access.view', 'access.user.password.reset'];

  it('offers reset only with the capability, never for yourself, and disables out-of-authority targets', async () => {
    mockAccess(new Response('{}'));
    const { rerender } = render(<AccessAdministration capabilities={['access.view']} currentUserId="u-1" onUnauthorized={vi.fn()} />);
    await screen.findByText('clerk@example.com');
    expect(screen.queryByRole('button', { name: 'Reset password' })).toBeNull();
    rerender(<AccessAdministration capabilities={caps} currentUserId="u-1" onUnauthorized={vi.fn()} />);
    const buttons = await screen.findAllByRole('button', { name: 'Reset password' });
    expect(buttons).toHaveLength(2); // not for the signed-in user
    expect(buttons[1]).toBeDisabled(); // can_manage === false
  });

  it('confirms first, then shows the temporary password once and forgets it on close', async () => {
    const calls = mockAccess(new Response(JSON.stringify({ temporaryPassword: 'Abcd2345Efgh6789', mustChangePassword: true }), { status: 200 }));
    render(<AccessAdministration capabilities={caps} currentUserId="u-1" onUnauthorized={vi.fn()} />);
    const row = (await screen.findByText('clerk@example.com')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Reset password' }));
    expect(calls.some((c) => c.url.endsWith('/reset-password'))).toBe(false);
    const confirmButtons = await screen.findAllByRole('button', { name: 'Reset password' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);
    expect(await screen.findByTestId('temporary-password')).toHaveTextContent('Abcd2345Efgh6789');
    expect(calls.find((c) => c.url.endsWith('/reset-password'))).toEqual({ url: '/api/access/memberships/m-2/reset-password', method: 'POST' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('temporary-password')).toBeNull());
    expect(document.body.textContent).not.toContain('Abcd2345Efgh6789');
  });

  it('shows the server refusal in plain language', async () => {
    mockAccess(new Response(JSON.stringify({ error: 'Forbidden', code: 'ACCESS_PASSWORD_RESET_CROSS_COMPANY' }), { status: 403 }));
    render(<AccessAdministration capabilities={caps} currentUserId="u-1" onUnauthorized={vi.fn()} />);
    const row = (await screen.findByText('clerk@example.com')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Reset password' }));
    const dialogButtons = await screen.findAllByRole('button', { name: 'Reset password' });
    fireEvent.click(dialogButtons[dialogButtons.length - 1]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('belongs to another company');
  });
});
