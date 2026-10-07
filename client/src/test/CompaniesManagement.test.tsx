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

  it.each([
    ['COMPANY_LAST_ACTIVE_CONFLICT', 'en', 'This company cannot be disabled because it is your last active company.'],
    ['COMPANY_LAST_ACTIVE_CONFLICT', 'ar', 'لا يمكن تعطيل هذه الشركة لأنها آخر شركة نشطة متاحة لك.'],
  ] as const)('maps %s (%s) to its translated message, never the raw backend text', async (code, lang, message) => {
    await i18n.changeLanguage(lang);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/companies' && !init?.method) return new Response(JSON.stringify({ companies }), { status: 200 });
      return new Response(JSON.stringify({ error: 'Conflict', code }), { status: 409 });
    }));
    renderIt(ALL);
    const row = (await screen.findByText(lang === 'ar' ? 'ألفا' : 'Alpha Co')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: lang === 'ar' ? 'تعطيل' : 'Disable' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText('Conflict')).toBeNull();
  });

  it('maps a duplicate slug on create to COMPANY_SLUG_CONFLICT', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/companies' && !init?.method) return new Response(JSON.stringify({ companies }), { status: 200 });
      return new Response(JSON.stringify({ error: 'Conflict', code: 'COMPANY_SLUG_CONFLICT' }), { status: 409 });
    }));
    renderIt(ALL);
    await screen.findByText('Alpha Co');
    fireEvent.click(screen.getByRole('button', { name: 'New company' }));
    const dialog = screen.getByRole('dialog');
    const inputs = within(dialog).getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'alpha' } });
    fireEvent.change(inputs[1], { target: { value: 'Alpha Two' } });
    fireEvent.submit(dialog.querySelector('form')!);
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('This short code is already in use. Choose another one.');
  });

  it('shows the shared network message for connection failures and a generic message for unknown 500s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const first = renderIt(ALL);
    expect(await screen.findByText('Could not connect to the server. Check your connection and try again.')).toBeInTheDocument();
    first.unmount();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'boom: relation x does not exist' }), { status: 500 })));
    renderIt(ALL);
    expect(await screen.findByText(/Something went wrong|Unable to|could not/i)).toBeInTheDocument();
    expect(screen.queryByText(/relation x/)).toBeNull();
  });
});
