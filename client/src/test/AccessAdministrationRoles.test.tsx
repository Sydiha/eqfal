import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { AccessAdministration } from '../components/AccessAdministration';

const members = [
  { id: 'm-1', user_id: 'u-1', user_email: 'owner@example.com', user_is_active: true, role_id: 'r-full', role_name: 'Owner', is_active: true },
  { id: 'm-2', user_id: 'u-2', user_email: 'clerk@example.com', user_is_active: true, role_id: 'r-clerk', role_name: 'Clerk', is_active: true },
];
const roles = [
  { id: 'r-full', name: 'Owner', is_full_access: true, capabilities: [] },
  { id: 'r-clerk', name: 'Clerk', is_full_access: false, capabilities: ['document.view'], editable: true },
  { id: 'r-mgr', name: 'Manager', is_full_access: false, capabilities: ['document.view', 'access.role.create'], editable: false },
];
const ALL = ['access.view', 'access.role.create', 'document.view'];
const detail = (over: Record<string, unknown>) => ({
  membership_id: 'x', company_id: 'c', company_name: 'Alpha Co', company_name_ar: 'شركة ألفا', company_is_active: true, is_active: true, is_current_company: true,
  role: { id: 'r-clerk', name: 'Clerk', is_full_access: false }, role_capabilities: ['document.view'], effective_capabilities: ['document.view'], effective_source: 'role', ...over,
});

type Handler = (url: string, init?: RequestInit) => Response | undefined;
function mockApi(extra: Handler = () => undefined) {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const custom = extra(url, init);
    if (custom) return custom;
    if (url === '/api/access/memberships') return new Response(JSON.stringify({ memberships: members }), { status: 200 });
    if (url === '/api/access/roles') return new Response(JSON.stringify({ roles }), { status: 200 });
    if (url === '/api/access/capabilities') return new Response(JSON.stringify({ capabilities: ['document.view'], sensitivity: {} }), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
  return calls;
}
const renderIt = (caps: readonly string[]) => render(<AccessAdministration capabilities={caps} currentUserId="u-1" onUnauthorized={vi.fn()} />);
beforeEach(async () => { cleanup(); await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('member details dialog', () => {
  it('separates role permissions from effective permissions and marks the Full Access wildcard and System Admin authority', async () => {
    mockApi((url) => url === '/api/access/memberships/m-1/details' ? new Response(JSON.stringify({
      user: { id: 'u-1', email: 'owner@example.com', is_active: true, is_system_admin: true },
      companies: [
        detail({ membership_id: 'a', role: { id: 'r-full', name: 'Owner', is_full_access: true }, role_capabilities: [], effective_capabilities: ['document.edit', 'document.view'], effective_source: 'full_access_wildcard' }),
        detail({ membership_id: 'b', company_id: 'c2', company_name: 'Beta Co', is_current_company: false, effective_source: 'system_admin_global', effective_capabilities: ['document.edit', 'document.view'], role: null, role_capabilities: [] }),
      ],
    }), { status: 200 }) : undefined);
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('button', { name: 'Details owner@example.com' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Alpha Co');
    expect(within(dialog).getByText(/Full Access wildcard: every permission, including future ones/)).toBeInTheDocument();
    expect(within(dialog).getByText(/future permissions are included automatically/)).toBeInTheDocument();
    expect(within(dialog).getByText(/global System Admin authority/)).toBeInTheDocument();
    expect(within(dialog).getByRole('note')).toHaveTextContent('System Admin');
    expect(within(dialog).getByText('Beta Co')).toBeInTheDocument();
    // effective list is collapsed until requested
    expect(within(dialog).queryByTitle('document.view')).toBeNull();
    fireEvent.click(within(dialog).getAllByRole('button', { name: /Show effective permissions \(2\)/ })[0]!);
    expect(within(dialog).getAllByTitle('document.view').length).toBeGreaterThan(0);
  });

  it('shows empty, error with retry, and calls only the membership details endpoint', async () => {
    let fail = true;
    const calls = mockApi((url) => {
      if (url !== '/api/access/memberships/m-2/details') return undefined;
      if (fail) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ user: { id: 'u-2', email: 'clerk@example.com', is_active: true, is_system_admin: false }, companies: [] }), { status: 200 });
    });
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('button', { name: 'Details clerk@example.com' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/could not be completed/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByText(/No company memberships are visible to you/)).toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes('/details')).every((c) => c.url === '/api/access/memberships/m-2/details' && c.method === 'GET')).toBe(true);
  });

  it('renders Arabic labels', async () => {
    await i18n.changeLanguage('ar');
    mockApi((url) => url === '/api/access/memberships/m-2/details' ? new Response(JSON.stringify({
      user: { id: 'u-2', email: 'clerk@example.com', is_active: true, is_system_admin: false }, companies: [detail({})],
    }), { status: 200 }) : undefined);
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('button', { name: /التفاصيل clerk@example.com/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('شركة ألفا')).toBeInTheDocument();
    expect(within(dialog).getByText('الصلاحيات الفعلية')).toBeInTheDocument();
    expect(within(dialog).getByText('صلاحيات الدور')).toBeInTheDocument();
  });
});

describe('role clone and rename controls', () => {
  const openRole = async (name: string) => { fireEvent.click(await screen.findByRole('tab', { name: 'Roles & permissions' })); fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) })); };

  it('clones the selected role by name only and reports omitted administrative permissions', async () => {
    const calls = mockApi((url, init) => url === '/api/access/roles/r-clerk/clone' && init?.method === 'POST'
      ? new Response(JSON.stringify({ role: { id: 'r-new', company_id: 'c', name: 'Clerk 2', is_full_access: false }, copied_capabilities: ['document.view'], omitted_capabilities: ['access.role.create'] }), { status: 201 }) : undefined);
    renderIt(ALL);
    await openRole('Clerk');
    fireEvent.click(await screen.findByRole('button', { name: 'Clone role' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/never copied/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('New role name'), { target: { value: 'Clerk 2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/clone'))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/clone'))!.body!)).toEqual({ name: 'Clerk 2' });
    expect(await screen.findByRole('status')).toHaveTextContent('not copied: 1');
  });

  it('renames with PATCH and only the name', async () => {
    const calls = mockApi();
    renderIt(ALL);
    await openRole('Clerk');
    fireEvent.click(await screen.findByRole('button', { name: 'Rename role' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Role name') as HTMLInputElement;
    expect(input.value).toBe('Clerk');
    fireEvent.change(input, { target: { value: 'Senior Clerk' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/access/roles/r-clerk');
    expect(JSON.parse(patch.body!)).toEqual({ name: 'Senior Clerk' });
  });

  it('protects Full Access: no clone or rename controls, a clear note instead', async () => {
    mockApi();
    renderIt(ALL);
    await openRole('Owner');
    expect(await screen.findByText(/cannot be renamed or cloned/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clone role' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename role' })).toBeNull();
  });

  it('disables rename when the server marks the role non-editable, and hides both without access.role.create', async () => {
    mockApi();
    renderIt(ALL);
    await openRole('Manager');
    expect(await screen.findByRole('button', { name: 'Rename role' })).toBeDisabled();
    cleanup();
    mockApi();
    renderIt(['access.view']);
    await openRole('Clerk');
    expect(screen.queryByRole('button', { name: 'Clone role' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename role' })).toBeNull();
  });

  it('shows a server conflict (duplicate name) inside the dialog', async () => {
    mockApi((url, init) => url === '/api/access/roles/r-clerk' && init?.method === 'PATCH' ? new Response(JSON.stringify({ error: 'Conflict' }), { status: 409 }) : undefined);
    renderIt(ALL);
    await openRole('Clerk');
    fireEvent.click(await screen.findByRole('button', { name: 'Rename role' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Role name'), { target: { value: 'Manager' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists');
  });
});
