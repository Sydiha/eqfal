import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { AccessAdministration } from '../components/AccessAdministration';

const members = [
  { id: 'm-1', user_id: 'u-1', user_email: 'owner@example.com', user_is_active: true, role_id: 'r-full', role_name: 'Owner', is_active: true },
  { id: 'm-2', user_id: 'u-2', user_email: 'clerk@example.com', user_is_active: true, role_id: 'r-clerk', role_name: 'Clerk', is_active: false },
];
const roles = [
  { id: 'r-full', name: 'Owner', is_full_access: true, capabilities: [] },
  { id: 'r-clerk', name: 'Clerk', is_full_access: false, capabilities: ['document.view'] },
];
const allCapabilities = ['document.view', 'document.edit', 'vat.view'];
const ALL = ['access.view', 'access.membership.create', 'access.membership.status.edit', 'access.membership.role.assign', 'access.role.create', 'access.role.capability.grant', 'access.role.capability.revoke', 'document.view', 'document.edit'];

function mockApi() {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    if (url === '/api/access/memberships' && !init?.method) return new Response(JSON.stringify({ memberships: members }), { status: 200 });
    if (url === '/api/access/roles' && !init?.method) return new Response(JSON.stringify({ roles }), { status: 200 });
    if (url === '/api/access/capabilities') return new Response(JSON.stringify({ capabilities: allCapabilities }), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
  return calls;
}
const renderIt = (caps: readonly string[]) => render(<AccessAdministration capabilities={caps} currentUserId="u-1" onUnauthorized={vi.fn()} />);

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('AccessAdministration', () => {
  it('shows a no-access state and makes no request without access.view', () => {
    const calls = mockApi();
    renderIt(['access.membership.create']);
    expect(screen.getByRole('status')).toHaveTextContent('do not have permission');
    expect(calls).toHaveLength(0);
  });

  it('is read-only without write capabilities', async () => {
    mockApi();
    renderIt(['access.view']);
    expect(await screen.findByText('clerk@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add member' })).toBeNull();
    expect(screen.queryByRole('button', { name: /membership/i })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('disables and enables a membership via the membership endpoint only', async () => {
    const calls = mockApi();
    renderIt(ALL);
    const row = (await screen.findByText('clerk@example.com')).closest('tr')!;
    expect(within(row).getByText('Disabled')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Enable membership' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/access/memberships/m-2/active');
    expect(JSON.parse(patch.body!)).toEqual({ is_active: true });
  });

  it('does not let a user disable their own active membership', async () => {
    mockApi();
    renderIt(ALL);
    const row = (await screen.findByText('owner@example.com')).closest('tr')!;
    expect(within(row).getByRole('button', { name: 'Disable membership' })).toBeDisabled();
  });

  it('assigns a role and adds a member by email without sending any company id', async () => {
    const calls = mockApi();
    renderIt(ALL);
    const row = (await screen.findByText('clerk@example.com')).closest('tr')!;
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'r-full' } });
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ role_id: 'r-full' });

    fireEvent.click(screen.getByRole('button', { name: 'Add member' }));
    fireEvent.change(screen.getByLabelText('User email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/access/memberships');
    expect(JSON.parse(post.body!)).toEqual({ email: 'new@example.com' });
  });

  it('creates a brand-new user with a role through the dedicated endpoint', async () => {
    const calls = mockApi();
    renderIt(ALL);
    await screen.findByText('clerk@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Create new user' }));
    fireEvent.change(screen.getByLabelText('User email'), { target: { value: 'fresh@example.com' } });
    fireEvent.change(screen.getByLabelText('Temporary password'), { target: { value: 'Passw0rd!x' } });
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('combobox'), { target: { value: 'r-clerk' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/access/users');
    expect(JSON.parse(post.body!)).toEqual({ email: 'fresh@example.com', password: 'Passw0rd!x', role_id: 'r-clerk' });
  });

  it('hides create-user without access.membership.create', async () => {
    mockApi();
    renderIt(['access.view']);
    await screen.findByText('clerk@example.com');
    expect(screen.queryByRole('button', { name: 'Create new user' })).toBeNull();
  });

  it('changes role capabilities through grant/revoke endpoints and respects the ceiling', async () => {
    const calls = mockApi();
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('tab', { name: 'Roles & permissions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Clerk/ }));
    const grant = screen.getByLabelText('Edit documents');
    expect(grant).not.toBeChecked();
    expect(screen.getByLabelText('View VAT')).toBeDisabled(); // actor does not hold it
    fireEvent.click(grant);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.url).toBe('/api/access/roles/r-clerk/capabilities/document.edit');
    fireEvent.click(screen.getByLabelText('View documents'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/access/roles/r-clerk/capabilities/document.view');
  });

  it('shows localized capability names (raw IDs only as secondary text)', async () => {
    mockApi();
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('tab', { name: 'Roles & permissions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Clerk/ }));
    expect(screen.getByLabelText('Edit documents')).toBeInTheDocument();
    expect(screen.getByText('document.edit')).toBeInTheDocument();
    cleanup();
    await i18n.changeLanguage('ar');
    mockApi();
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('tab', { name: 'الأدوار والصلاحيات' }));
    fireEvent.click(await screen.findByRole('button', { name: /Clerk/ }));
    expect(screen.getByLabelText('تعديل المستندات')).toBeInTheDocument();
  });

  it('selects/clears all and group-selects with an indeterminate state, honouring the ceiling', async () => {
    const calls = mockApi();
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('tab', { name: 'Roles & permissions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Clerk/ }));
    const group = screen.getByLabelText('Documents') as HTMLInputElement; // clerk holds document.view only
    expect(group.indeterminate).toBe(true);
    fireEvent.click(group);
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual(['/api/access/roles/r-clerk/capabilities/document.edit']));
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').length).toBeGreaterThan(1));
    // never grants what the actor does not hold (vat.view is outside the ceiling)
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('vat.view'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('disables bulk controls without grant/revoke capabilities', async () => {
    mockApi();
    renderIt(['access.view']);
    fireEvent.click(await screen.findByRole('tab', { name: 'Roles & permissions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Clerk/ }));
    expect(screen.getByRole('button', { name: 'Select all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled();
    expect(screen.getByLabelText('Documents')).toBeDisabled();
  });

  it('does not allow editing a Full Access role', async () => {
    mockApi();
    renderIt(ALL);
    fireEvent.click(await screen.findByRole('tab', { name: 'Roles & permissions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Owner/ }));
    expect(screen.getByText(/cannot be edited/)).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('renders Arabic labels', async () => {
    await i18n.changeLanguage('ar');
    mockApi();
    renderIt(['access.view']);
    expect(await screen.findByText('المستخدمون والصلاحيات')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'الأعضاء' })).toBeInTheDocument();
  });

  it('shows a server-side 403 as an error instead of failing silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    renderIt(['access.view']);
    expect(await screen.findByRole('alert')).toHaveTextContent('not allowed');
  });
});
