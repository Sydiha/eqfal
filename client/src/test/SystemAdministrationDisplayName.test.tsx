import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { SystemAdministration } from '../components/SystemAdministration';

const calls: { url: string; method: string; body: unknown }[] = [];
const user = { id: '00000000-0000-4000-8000-000000000009', email: 'named@example.test', display_name: 'Sara', is_active: true, is_system_admin: false, active_memberships: 0 };
beforeEach(async () => {
  calls.length = 0;
  await act(async () => { await i18n.changeLanguage('en'); });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = url.includes('/memberships') ? { memberships: [] } : url.includes('/admin/users') && (init.method ?? 'GET') === 'GET' ? { users: [user] }
      : url.includes('/admin/companies') ? { companies: [] } : url.includes('/admin/capabilities') ? { capabilities: [], sensitivity: {} } : user;
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

const renderAdmin = () => render(<MantineProvider><SystemAdministration currentUserId="me" onUnauthorized={vi.fn()} /></MantineProvider>);

describe('System Admin display name', () => {
  it('lists the stored name and lets a System Admin edit or clear it', async () => {
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: /Sara/ }));
    const input = await screen.findByLabelText(i18n.t('access.displayName')) as HTMLInputElement;
    expect(input.value).toBe('Sara');
    fireEvent.change(input, { target: { value: '  Sara Ahmed ' } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('systemAdmin.saveName') }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.url.endsWith(`/admin/users/${user.id}/display-name`))).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ display_name: 'Sara Ahmed' });
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('systemAdmin.saveName') }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toEqual({ display_name: null }));
  });

  it('asks the shell to refresh the session after a change, so the header shows the new name', async () => {
    const onAccessChanged = vi.fn();
    render(<MantineProvider><SystemAdministration currentUserId={user.id} onUnauthorized={vi.fn()} onAccessChanged={onAccessChanged} /></MantineProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /Sara/ }));
    fireEvent.change(await screen.findByLabelText(i18n.t('access.displayName')), { target: { value: 'Sara Ahmed' } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('systemAdmin.saveName') }));
    await waitFor(() => expect(onAccessChanged).toHaveBeenCalled());
  });

  it('sends an optional name when creating an account and omits it when blank', async () => {
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('access.createUser') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(dialog.querySelector('input[name="email"]')!, { target: { value: 'new@example.test' } });
    fireEvent.change(dialog.querySelector('input[name="password"]')!, { target: { value: 'Long-enough-1' } });
    fireEvent.submit(dialog.querySelector('form')!);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/admin/users'))).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ email: 'new@example.test', password: 'Long-enough-1' });
  });
});
