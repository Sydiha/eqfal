import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';
import i18n from '../i18n';

function setSession(capabilities: string[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    user: { id: 'u1', email: 'user@example.com' },
    allowedCompanies: [{ id: 'co-1', name: 'Company One', name_ar: null }],
    activeCompanyId: 'co-1',
    capabilities,
  }), { status: 200 })));
}

describe('global page navigation search', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    window.history.replaceState(null, '', '/');
  });

  it('opens without document access and navigates to an allowed English result with Enter', async () => {
    setSession(['annual_close.view', 'accounting.view']);
    render(<AuthProvider><App /></AuthProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Search pages' }));
    const dialog = screen.getByRole('dialog', { name: 'Navigate to a page' });
    const input = within(dialog).getByRole('combobox', { name: 'Search pages' });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'a' } });
    const annualClosing = within(dialog).getByRole('option', { name: /Annual Closing/ });
    const accounting = within(dialog).getByRole('option', { name: /Accounting/ });
    expect(annualClosing).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).queryByRole('option', { name: /Documents/ })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(accounting).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.search).toContain('page=accounting');
  });

  it('matches Arabic page names and navigates when a result is selected', async () => {
    await i18n.changeLanguage('ar');
    setSession(['document.view']);
    render(<AuthProvider><App /></AuthProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'بحث في الصفحات' }));
    const dialog = screen.getByRole('dialog', { name: 'الانتقال إلى صفحة' });
    const input = within(dialog).getByRole('combobox', { name: 'ابحث في الصفحات' });
    fireEvent.change(input, { target: { value: 'المستندات' } });
    fireEvent.click(within(dialog).getByRole('option', { name: /المستندات/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.search).toContain('page=documents');
  });

  it('shows start and no-result states, clears the query, and closes with Escape', async () => {
    setSession(['fiscal_year.view']);
    render(<AuthProvider><App /></AuthProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Search pages' }));
    const dialog = screen.getByRole('dialog', { name: 'Navigate to a page' });
    const input = within(dialog).getByRole('combobox', { name: 'Search pages' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('Type a page name in Arabic or English.');
    fireEvent.change(input, { target: { value: 'nothing matches' } });
    expect(within(dialog).getByRole('status')).toHaveTextContent('No pages found.');
    fireEvent.change(input, { target: { value: 'fiscal' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear search' }));
    expect(input).toHaveValue('');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Type a page name in Arabic or English.');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
