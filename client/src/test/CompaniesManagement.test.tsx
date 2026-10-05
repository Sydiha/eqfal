import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { CompaniesManagement } from '../components/CompaniesManagement';

const companies = [
  { id: 'c-1', slug: 'alpha', name: 'Alpha Co', name_ar: 'ألفا', is_active: true, can_edit: true, can_toggle: true },
  { id: 'c-2', slug: 'beta', name: 'Beta Co', name_ar: null, is_active: false, can_edit: false, can_toggle: true },
];
const ALL = ['company.view', 'company.create', 'company.edit', 'company.status.edit'];

function mockApi(status = 200) {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    if (url === '/api/companies' && !init?.method) return new Response(JSON.stringify({ companies }), { status: 200 });
    return new Response('{}', { status });
  }));
  return calls;
}
const renderIt = (caps: readonly string[], onChanged = vi.fn()) => ({ onChanged, ...render(<CompaniesManagement capabilities={caps} onUnauthorized={vi.fn()} onChanged={onChanged} />) });

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('CompaniesManagement', () => {
  it('shows a no-access state and makes no request without company.view', () => {
    const calls = mockApi();
    renderIt(['company.create']);
    expect(screen.getByRole('status')).toHaveTextContent('do not have permission');
    expect(calls).toHaveLength(0);
  });

  it('is read-only without write capabilities and never offers delete', async () => {
    mockApi();
    renderIt(['company.view']);
    expect(await screen.findByText('Alpha Co')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New company' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('creates a company and reloads the session', async () => {
    const calls = mockApi();
    const { onChanged } = renderIt(ALL);
    await screen.findByText('Alpha Co');
    fireEvent.click(screen.getByRole('button', { name: 'New company' }));
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Gamma' } });
    fireEvent.change(screen.getByLabelText('Short code'), { target: { value: 'Gamma-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/companies');
    expect(JSON.parse(post.body!)).toEqual({ slug: 'gamma-1', name: 'Gamma' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('edits only allowed details (name / Arabic name), slug stays read-only', async () => {
    const calls = mockApi();
    renderIt(ALL);
    const row = (await screen.findByText('Alpha Co')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Short code')).toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Alpha Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/companies/c-1');
    expect(JSON.parse(patch.body!)).toEqual({ name: 'Alpha Renamed', name_ar: 'ألفا' });
  });

  it('hides edit when the server says the user cannot edit that company', async () => {
    mockApi();
    renderIt(ALL);
    const row = (await screen.findByText('Beta Co')).closest('tr')!;
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(row).getByText('Disabled')).toBeInTheDocument();
  });

  it('disables and enables via the active endpoint only', async () => {
    const calls = mockApi();
    renderIt(ALL);
    const disableRow = (await screen.findByText('Alpha Co')).closest('tr')!;
    fireEvent.click(within(disableRow).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.url).toBe('/api/companies/c-1/active');
    expect(JSON.parse(calls.find((c) => c.method === 'PATCH')!.body!)).toEqual({ is_active: false });
    const enableRow = (await screen.findByText('Beta Co')).closest('tr')!;
    fireEvent.click(within(enableRow).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(JSON.parse(calls.filter((c) => c.method === 'PATCH')[1].body!)).toEqual({ is_active: true });
  });

  it('shows a localized conflict error and supports Arabic', async () => {
    mockApi(409);
    await i18n.changeLanguage('ar');
    renderIt(ALL);
    const row = (await screen.findByText('ألفا')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'تعطيل' }));
    expect(await screen.findByText(/تعارض/)).toBeInTheDocument();
  });
});
