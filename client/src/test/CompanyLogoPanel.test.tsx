import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { CompaniesManagement } from '../components/CompaniesManagement';
import { CompanyProvider } from '../context/CompanyContext';

const companies = [
  { id: 'c-1', slug: 'alpha', name: 'Alpha Co', name_ar: 'ألفا', is_active: true, can_edit: true, can_toggle: true },
  { id: 'c-2', slug: 'beta', name: 'Beta Co', name_ar: null, is_active: true, can_edit: true, can_toggle: true },
];
function api(initialLogo: boolean) {
  let has = initialLogo; const calls: Array<{ url: string; method: string; type?: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'; calls.push({ url, method, type: (init?.headers as Record<string, string> | undefined)?.['content-type'] });
    if (url === '/api/companies') return new Response(JSON.stringify({ companies }));
    if (url === '/api/companies/c-1/logo') {
      if (method === 'PUT') { has = true; return new Response('{}'); }
      if (method === 'DELETE') { has = false; return new Response(null, { status: 204 }); }
      return has ? new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 }) : new Response('{}', { status: 404 });
    }
    return new Response('{}', { status: 404 });
  }));
  URL.createObjectURL = vi.fn(() => 'blob:logo'); URL.revokeObjectURL = vi.fn();
  return calls;
}
const mount = (caps = ['company.view', 'company.edit']) => render(<CompanyProvider allowedCompanies={[{ id: 'c-1', name: 'Alpha Co' }, { id: 'c-2', name: 'Beta Co' }]} initialCompanyId="c-1"><CompaniesManagement capabilities={caps} onUnauthorized={vi.fn()} onChanged={vi.fn()} /></CompanyProvider>);
const open = async (name: string) => { await screen.findByText(name); fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[name === 'Alpha Co' ? 0 : 1]!); };
const file = (type: string, size = 10) => new File([new Uint8Array(size)], 'logo', { type });
const input = () => document.querySelector('input[type=file]') as HTMLInputElement;

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('company logo panel', () => {
  it('shows no-logo state, uploads, then shows preview and Replace/Remove; remove returns to empty', async () => {
    const calls = api(false); mount(); await open('Alpha Co');
    expect(await screen.findByText('No logo uploaded')).toBeInTheDocument();
    fireEvent.change(input(), { target: { files: [file('image/png')] } });
    expect(await screen.findByAltText('Current company logo')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ url: '/api/companies/c-1/logo', type: 'image/png' });
    expect(screen.getByText('Replace logo')).toBeInTheDocument();
    fireEvent.change(input(), { target: { files: [file('image/webp')] } });
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Remove logo' }));
    expect(await screen.findByText('No logo uploaded')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });
  it('rejects SVG and oversized files in the browser without calling the server', async () => {
    const calls = api(false); mount(); await open('Alpha Co'); await screen.findByText('No logo uploaded');
    fireEvent.change(input(), { target: { files: [file('image/svg+xml')] } });
    expect(await screen.findByText(/Logo rejected/)).toBeInTheDocument();
    fireEvent.change(input(), { target: { files: [file('image/png', 600 * 1024)] } });
    expect(await screen.findByText(/too large/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
  it('hides upload controls without company.edit and for non-active companies', async () => {
    api(true); mount(['company.view']); 
    expect(await screen.findByText('Alpha Co')).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Edit' })).toHaveLength(0);
  });
  it('asks to switch company before previewing a non-active company logo (no logo request)', async () => {
    const calls = api(true); mount(); await open('Beta Co');
    expect(await screen.findByText(/Switch to this company/)).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/companies/c-2/logo')).toBe(false);
    expect(document.querySelector('input[type=file]')).toBeNull();
  });
  it('renders in Arabic', async () => {
    await i18n.changeLanguage('ar'); api(false); mount();
    await screen.findByText('ألفا'); fireEvent.click(screen.getAllByRole('button', { name: 'تعديل' })[0]!);
    expect(await screen.findByText('لا يوجد شعار')).toBeInTheDocument(); expect(screen.getByText('رفع الشعار')).toBeInTheDocument();
  });
});
