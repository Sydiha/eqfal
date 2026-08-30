import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { WorkspaceState, WorkspaceToolbar } from '../components/SharedUI';
import { AuthProvider } from '../context/AuthContext';
import { clearContextualQueryState, clearQueryParameters, navigateToQueryState, readQueryParameter, writeQueryParameters } from '../navigation/queryState';
import i18n from '../i18n';

describe('query state foundation', () => {
  beforeEach(() => window.history.replaceState(null, '', '/'));

  it('reads, validates, writes, and clears parameters while preserving unrelated state', () => {
    window.history.replaceState(null, '', '/?page=documents&search=vendor&status=unknown');
    expect(readQueryParameter('search')).toBe('vendor');
    expect(readQueryParameter('status', { allowedValues: ['approved', 'needs_review'] })).toBeNull();
    writeQueryParameters({ status: 'needs_review', from: '2026-01-01' });
    expect(window.location.search).toBe('?page=documents&search=vendor&status=needs_review&from=2026-01-01');
    clearQueryParameters(['search', 'status']);
    expect(window.location.search).toBe('?page=documents&from=2026-01-01');
  });

  it('removes company context but retains the safe page destination', () => {
    window.history.replaceState(null, '', '/?page=banks&section=transactions&reconciliation=unmatched');
    clearContextualQueryState();
    expect(window.location.search).toBe('?page=banks');
  });

  it('pushes a collision-free discovery destination and preserves the source history entry', () => {
    window.history.replaceState(null, '', '/?page=monthlyClose&closeYear=fy&closePeriod=period');
    navigateToQueryState({ page: 'banks', section: 'transactions', from: '2026-01-01', to: '2026-01-31' });
    expect(window.location.search).toBe('?page=banks&section=transactions&from=2026-01-01&to=2026-01-31');
  });
});

describe('shared search and navigation behavior', () => {
  beforeEach(async () => {
    window.history.replaceState(null, '', '/');
    await i18n.changeLanguage('en');
    const session = (activeCompanyId: string) => ({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [{ id: 'co-1', name: 'One', name_ar: null }, { id: 'co-2', name: 'Two', name_ar: null }], activeCompanyId, capabilities: ['document.view'] });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/session') return new Response(JSON.stringify(session('co-1')), { status: 200 });
      if (url === '/api/auth/switch-company') return new Response(JSON.stringify(session(JSON.parse(String(options?.body)).companyId)), { status: 200 });
      if (url === '/api/documents') return new Response(JSON.stringify({ documents: [], counterparties: [] }), { status: 200 });
      return new Response(null, { status: 404 });
    }));
  });

  it('keeps toolbar controls keyboard-accessible and semantic in RTL', async () => {
    await i18n.changeLanguage('ar');
    render(<WorkspaceToolbar search={<label>بحث<input type="search" /></label>} filters={<label>الحالة<select><option>الكل</option></select></label>} resultCount={0} clearAction={<button>مسح</button>} />);
    expect(screen.getByRole('search')).toContainElement(screen.getByRole('searchbox', { name: 'بحث' }));
    expect(screen.getByRole('status')).toHaveTextContent('0');
    fireEvent.keyDown(screen.getByRole('button', { name: 'مسح' }), { key: 'Enter' });
    expect(screen.getByRole('combobox', { name: 'الحالة' })).toBeEnabled();
  });

  it('distinguishes empty datasets from filtered zero-result states', () => {
    render(<><WorkspaceState kind="empty">Empty</WorkspaceState><WorkspaceState kind="no-results">No results</WorkspaceState></>);
    expect(screen.getByText('Empty').closest('[data-state]')).toHaveAttribute('data-state', 'empty');
    expect(screen.getByText('No results').closest('[data-state]')).toHaveAttribute('data-state', 'no-results');
  });

  it('restores valid pages through browser history and safely ignores invalid pages', async () => {
    render(<AuthProvider><App /></AuthProvider>);
    const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
    fireEvent.click(within(navigation).getByRole('button', { name: 'Documents' }));
    expect(window.location.search).toBe('?page=documents');
    act(() => { window.history.pushState(null, '', '/?page=future-page&status=bad'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(within(navigation).getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    act(() => { window.history.replaceState(null, '', '/?page=documents'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(within(navigation).getByRole('button', { name: 'Documents' })).toHaveAttribute('aria-current', 'page');
  });

  it('clears stale operational state on company switch', async () => {
    window.history.replaceState(null, '', '/?page=documents&search=old-company');
    render(<AuthProvider><App /></AuthProvider>);
    fireEvent.change(await screen.findByLabelText('Switch active company'), { target: { value: 'co-2' } });
    expect(window.location.search).toBe('?page=documents');
  });
});
