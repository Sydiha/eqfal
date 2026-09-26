import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';
import i18n from '../i18n';

describe('authenticated application shell', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [{ id: 'co-1', name: 'Company One', name_ar: null }], activeCompanyId: 'co-1', capabilities: ['fiscal_year.view', 'document.view'] }), { status: 200 }))); });
  it('navigates among capability-visible frontend workspaces', async () => {
    render(<AuthProvider><App/></AuthProvider>);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    const navigation = screen.getByRole('navigation', { name: 'Main navigation' });
    const brand = screen.getAllByRole('button', { name: 'Home' }).find((button) => button.classList.contains('sidebar-brand'))!;
    expect(within(brand).getByText('إقفال')).toBeInTheDocument();
    expect(within(brand).getByText('EQFAL')).toBeInTheDocument();
    expect(brand.querySelector('.eqfal-mark svg')).toBeInTheDocument();
    expect(within(navigation).getByText('Operations')).toBeInTheDocument();
    expect(within(navigation).getByText('Accounting')).toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Accounting' })).not.toBeInTheDocument();
    expect(within(navigation).getByText('Administration')).toBeInTheDocument();
    const fiscal = within(navigation).getByRole('button', { name: 'Fiscal Years' });
    const documents = within(navigation).getByRole('button', { name: 'Documents' });
    fireEvent.click(fiscal); expect(fiscal).toHaveAttribute('aria-current', 'page');
    fireEvent.click(documents); expect(documents).toHaveAttribute('aria-current', 'page');
    fireEvent.click(within(navigation).getByRole('button', { name: 'Home' }));
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });
  it('shows Sales navigation only with both required read capabilities', async () => {
    render(<AuthProvider><App/></AuthProvider>);
    const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(navigation).queryByRole('button', { name: 'Sales' })).not.toBeInTheDocument();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [{ id: 'co-1', name: 'Company One', name_ar: null }], activeCompanyId: 'co-1', capabilities: ['document.view', 'obligation.view'] }), { status: 200 })));
    render(<AuthProvider><App/></AuthProvider>);
    expect((await screen.findAllByRole('button', { name: 'Sales' })).length).toBeGreaterThan(0);
  });
  it('hides operational navigation without each relevant view capability', async () => {
    render(<AuthProvider><App/></AuthProvider>);
    const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(navigation).getByRole('button', { name: 'Documents' })).toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Banking' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Obligations' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Purchases' })).not.toBeInTheDocument();
  });

  it('mirrors the shell direction without duplicating the full brand lockup', async () => {
    const { container } = render(<AuthProvider><App/></AuthProvider>);
    await screen.findByRole('heading', { name: 'Welcome back' });

    expect(document.documentElement).toHaveAttribute('dir', 'ltr');
    expect(container.querySelector('.app-shell--v2')).toHaveAttribute('data-shell-direction', 'ltr');
    expect(screen.getByTestId('global-navigation-sidebar').querySelectorAll('.eqfal-brand-lockup')).toHaveLength(1);
    expect(screen.getByTestId('global-app-header').querySelector('.eqfal-brand-lockup')).not.toBeInTheDocument();

    await i18n.changeLanguage('ar');

    await waitFor(() => expect(document.documentElement).toHaveAttribute('dir', 'rtl'));
    expect(container.querySelector('.app-shell--v2')).toHaveAttribute('data-shell-direction', 'rtl');
    expect(screen.getByTestId('global-navigation-sidebar').querySelectorAll('.eqfal-brand-lockup')).toHaveLength(1);
  });
});
