import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { AuditLog } from '../components/AuditLog';

const entry = { id: 'e1', created_at: '2026-10-01T10:00:00Z', actor_user_id: 'u1', actor_email: 'owner@example.com', action: 'company.update', entity_type: 'company', entity_id: '0e8574b6-5828-40c6-9b56-7dbd1c7e9def', company_id: 'c1', company_name: 'Alpha Co', company_name_ar: 'ألفا', reason: 'Renamed', before_data: { name: 'Old' }, after_data: { name: 'New' } };
const facets = { actions: ['company.update'], entity_types: ['company'], actors: [{ id: 'u1', email: 'owner@example.com' }] };

function mockApi(status = 200, entries = [entry]) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    expect(init?.method ?? 'GET').toBe('GET');
    if (status !== 200) return new Response('{}', { status });
    if (url.startsWith('/api/audit-log/facets')) return new Response(JSON.stringify(facets), { status: 200 });
    return new Response(JSON.stringify({ entries, total: entries.length }), { status: 200 });
  }));
  return urls;
}
const renderIt = (canView = true, onUnauthorized = vi.fn()) => render(<AuditLog canView={canView} onUnauthorized={onUnauthorized} />);

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('AuditLog', () => {
  it('shows no-access and makes no request without audit.view', () => {
    const urls = mockApi();
    renderIt(false);
    expect(screen.getByRole('status')).toHaveTextContent('do not have permission');
    expect(urls).toHaveLength(0);
  });

  it('shows the required fields and offers no edit/delete controls', async () => {
    mockApi();
    renderIt();
    expect(await screen.findByText('owner@example.com', { selector: 'td' })).toBeInTheDocument();
    for (const text of ['company.update', 'Alpha Co', 'Renamed', entry.entity_id]) expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    for (const header of ['Time', 'User', 'Action', 'Entity', 'Reference', 'Company', 'Reason']) expect(screen.getAllByRole('columnheader', { name: header }).length).toBe(1);
    expect(screen.queryByRole('button', { name: /edit|delete|remove/i })).toBeNull();
  });

  it('expands before/after details', async () => {
    mockApi();
    renderIt();
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }));
    expect(screen.getByText(/"Old"/)).toBeInTheDocument();
    expect(screen.getByText(/"New"/)).toBeInTheDocument();
  });

  it('sends filters and search to the server and can clear them', async () => {
    const urls = mockApi();
    renderIt();
    await screen.findByText('Alpha Co');
    fireEvent.change(screen.getByPlaceholderText(/Action, entity/), { target: { value: 'rename' } });
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'company.update' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(urls.some((u) => u.includes('q=rename') && u.includes('action=company.update') && u.includes('from=2026-10-01'))).toBe(true));
    expect(urls.every((u) => !u.includes('company_id'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(urls[urls.length - 1]).not.toContain('q='));
  });

  it('shows an empty-results message when filters match nothing', async () => {
    mockApi(200, []);
    renderIt();
    expect(await screen.findByText('No audit entries yet.')).toBeInTheDocument();
  });

  it('reports 403 and 401 appropriately', async () => {
    mockApi(403);
    renderIt();
    expect(await screen.findByRole('alert')).toHaveTextContent('permission');
    const onUnauthorized = vi.fn();
    mockApi(401);
    renderIt(true, onUnauthorized);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });

  it('renders Arabic with the Arabic company name', async () => {
    await i18n.changeLanguage('ar');
    mockApi();
    renderIt();
    expect(await screen.findByText('ألفا')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'سجل التدقيق' })).toBeInTheDocument();
  });
});
