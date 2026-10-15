import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { AccessAdministration } from '../components/AccessAdministration';

const users = [
  { id: 'u-admin', email: 'admin@example.com', is_active: true, is_system_admin: true, active_memberships: 0 },
  { id: 'u-2', email: 'multi@example.com', is_active: true, is_system_admin: false, active_memberships: 2 },
];
const companies = [
  { id: 'c-a', name: 'Alpha', name_ar: null, slug: 'alpha', is_active: true },
  { id: 'c-b', name: 'Beta', name_ar: null, slug: 'beta', is_active: true },
  { id: 'c-c', name: 'Gamma', name_ar: null, slug: 'gamma', is_active: true },
];
const memberships = [
  { id: 'm-a', company_id: 'c-a', company_name: 'Alpha', company_name_ar: null, company_is_active: true, role_id: 'ra-viewer', role_name: 'Viewer', is_active: true },
  { id: 'm-b', company_id: 'c-b', company_name: 'Beta', company_name_ar: null, company_is_active: true, role_id: 'rb-acc', role_name: 'Accountant', is_active: true },
];
const rolesFor: Record<string, unknown[]> = {
  'c-a': [{ id: 'ra-viewer', name: 'Viewer', is_full_access: false, capabilities: ['invoice.view'] }, { id: 'ra-full', name: 'Full Access', is_full_access: true, capabilities: [] }],
  'c-b': [{ id: 'rb-acc', name: 'Accountant', is_full_access: false, capabilities: ['invoice.view'] }],
  'c-c': [{ id: 'rc-viewer', name: 'Viewer', is_full_access: false, capabilities: ['invoice.view'] }],
};

function mockApi() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    if (method !== 'GET') return ok({});
    if (url.startsWith('/api/admin/users/') && url.endsWith('/memberships')) return ok({ memberships });
    if (url.startsWith('/api/admin/users')) return ok({ users });
    if (url === '/api/admin/companies') return ok({ companies });
    const roles = url.match(/^\/api\/admin\/companies\/([^/]+)\/roles$/);
    if (roles) return ok({ roles: rolesFor[roles[1]!] ?? [] });
    if (url === '/api/admin/capabilities') return ok({ capabilities: ['invoice.view', 'fiscal_year.close'], sensitivity: { 'fiscal_year.close': 'critical' } });
    return ok({ memberships: [], roles: [], capabilities: [], sensitivity: {} });
  }));
  return calls;
}

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('Global administration (System Admin)', () => {
  it('is offered only to a System Admin', () => {
    mockApi();
    const { unmount } = render(<AccessAdministration capabilities={['access.view']} currentUserId="u-1" onUnauthorized={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: 'Global administration' })).toBeNull();
    unmount();
    render(<AccessAdministration capabilities={[]} currentUserId="u-admin" isSystemAdmin onUnauthorized={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Global administration' })).toBeInTheDocument();
  });

  it('shows a separate role per company and changes, disables and adds company access through /api/admin', async () => {
    const calls = mockApi();
    render(<AccessAdministration capabilities={[]} currentUserId="u-admin" isSystemAdmin onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /multi@example.com/ }));
    const alpha = await screen.findByRole('combobox', { name: 'Role Alpha' });
    await waitFor(() => expect(alpha).toHaveValue('ra-viewer'));
    expect(screen.getByRole('combobox', { name: 'Role Beta' })).toHaveValue('rb-acc');

    // Disabling one membership touches only that membership.
    const betaRow = screen.getByRole('combobox', { name: 'Role Beta' }).closest('tr')!;
    fireEvent.click(within(betaRow).getByRole('button', { name: 'Disable membership' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/admin/memberships/m-b/active', body: JSON.stringify({ is_active: false }) });

    // Moving to Full Access asks for the strongest confirmation, naming the user and company.
    fireEvent.change(screen.getByRole('combobox', { name: 'Role Alpha' }), { target: { value: 'ra-full' } });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('multi@example.com');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Alpha');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: '/api/admin/memberships/m-a/role', body: JSON.stringify({ role_id: 'ra-full' }) });

    // Only companies without a membership can be added.
    const form = screen.getByRole('form', { name: 'Add company access' });
    const [companySelect, roleSelect] = within(form).getAllByRole('combobox');
    expect(within(companySelect!).queryByRole('option', { name: 'Alpha' })).toBeNull();
    fireEvent.change(companySelect!, { target: { value: 'c-c' } });
    await waitFor(() => expect(within(roleSelect!).getByRole('option', { name: 'Viewer' })).toBeInTheDocument());
    fireEvent.change(roleSelect!, { target: { value: 'rc-viewer' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add company access' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/admin/memberships', body: JSON.stringify({ user_id: 'u-2', company_id: 'c-c', role_id: 'rc-viewer' }) });
  });

  it('confirms before granting System Admin but not before revoking it', async () => {
    const calls = mockApi();
    render(<AccessAdministration capabilities={[]} currentUserId="u-other" isSystemAdmin onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /multi@example.com/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Make System Admin' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Grant' })).toBeDisabled();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /admin@example.com/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove System Admin' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/admin/users/u-admin/system-admin')).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
