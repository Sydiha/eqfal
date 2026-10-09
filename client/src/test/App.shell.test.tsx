import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';
import i18n from '../i18n';

describe('authenticated application shell', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [{ id: 'co-1', name: 'Company One', name_ar: null }], activeCompanyId: 'co-1', capabilities: ['fiscal_year.view', 'document.view'] }), { status: 200 }))); });
  it('navigates among capability-visible frontend workspaces', async () => {
    render(<AuthProvider><App/></AuthProvider>);
    expect(await screen.findByRole('heading', { name: 'Financial overview' })).toBeInTheDocument();
    const navigation = screen.getByRole('navigation', { name: 'Main navigation' });
    const brand = screen.getAllByRole('button', { name: 'Home' }).find((button) => button.classList.contains('sidebar-brand'))!;
    expect(within(brand).getByText('إقفال')).toBeInTheDocument();
    expect(within(brand).getByText('EQFAL')).toBeInTheDocument();
    expect(brand.querySelector('.eqfal-mark svg')).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: 'Operations' })).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: 'Closing' })).toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Accounting' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Invoices' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Administration' })).not.toBeInTheDocument();
    const fiscal = within(navigation).getByRole('button', { name: 'Fiscal Years' });
    const documents = within(navigation).getByRole('button', { name: 'Documents' });
    fireEvent.click(fiscal); expect(fiscal).toHaveAttribute('aria-current', 'page');
    fireEvent.click(documents); expect(documents).toHaveAttribute('aria-current', 'page');
    fireEvent.click(within(navigation).getByRole('button', { name: 'Home' }));
    expect(screen.getByRole('heading', { name: 'Financial overview' })).toBeInTheDocument();
  });
  it('shows Sales navigation only with both required read capabilities', async () => {
    render(<AuthProvider><App/></AuthProvider>);
    const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(navigation).queryByRole('button', { name: 'Sales Invoices' })).not.toBeInTheDocument();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [{ id: 'co-1', name: 'Company One', name_ar: null }], activeCompanyId: 'co-1', capabilities: ['document.view', 'obligation.view'] }), { status: 200 })));
    render(<AuthProvider><App/></AuthProvider>);
    expect((await screen.findAllByRole('button', { name: 'Sales Invoices' })).length).toBeGreaterThan(0);
  });
  it('hides operational navigation without each relevant view capability', async () => {
    render(<AuthProvider><App/></AuthProvider>);
    const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(navigation).getByRole('button', { name: 'Documents' })).toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Banking' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Obligations' })).not.toBeInTheDocument();
    expect(within(navigation).queryByRole('button', { name: 'Purchase Invoices' })).not.toBeInTheDocument();
  });
  describe('collapsible groups', () => {
    const session = (capabilities: string[]) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [{ id: 'co-1', name: 'Company One', name_ar: null }], activeCompanyId: 'co-1', capabilities }), { status: 200 })));
    beforeEach(() => { window.localStorage.clear(); window.history.replaceState(null, '', '/'); });
    it('places Sales and Purchases under Invoices with invoice labels', async () => {
      session(['document.view', 'obligation.view']);
      render(<AuthProvider><App/></AuthProvider>);
      const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
      const toggle = within(navigation).getByRole('button', { name: 'Invoices' });
      const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
      expect(within(panel).getByRole('button', { name: 'Sales Invoices' })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Purchase Invoices' })).toBeInTheDocument();
      expect(within(navigation).getByRole('button', { name: 'Documents' })).toBeInTheDocument();
    });
    it('collapses, persists the preference, and hides empty groups', async () => {
      session(['document.view', 'fiscal_year.view']);
      render(<AuthProvider><App/></AuthProvider>);
      const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
      expect(within(navigation).queryByRole('button', { name: 'Invoices' })).not.toBeInTheDocument();
      const toggle = within(navigation).getByRole('button', { name: 'Closing' });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(within(navigation).queryByRole('button', { name: 'Fiscal Years' })).not.toBeInTheDocument();
      expect(JSON.parse(window.localStorage.getItem('eqfal.nav.collapsedGroups')!)).toEqual(['closing']);
    });
    it('keeps the active page group open despite a stored collapsed preference', async () => {
      window.localStorage.setItem('eqfal.nav.collapsedGroups', JSON.stringify(['operations', 'closing']));
      window.history.replaceState(null, '', '/?page=documents');
      session(['document.view', 'fiscal_year.view']);
      render(<AuthProvider><App/></AuthProvider>);
      const navigation = await screen.findByRole('navigation', { name: 'Main navigation' });
      const operations = within(navigation).getByRole('button', { name: 'Operations' });
      expect(operations).toHaveAttribute('aria-expanded', 'true');
      expect(within(navigation).getByRole('button', { name: 'Documents' })).toHaveAttribute('aria-current', 'page');
      expect(within(navigation).getByRole('button', { name: 'Closing' })).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(within(navigation).getByRole('button', { name: 'Closing' }));
      expect(within(navigation).getByRole('button', { name: 'Fiscal Years' })).toBeInTheDocument();
    });
    it('uses Arabic group and invoice labels', async () => {
      await i18n.changeLanguage('ar');
      session(['document.view', 'obligation.view']);
      render(<AuthProvider><App/></AuthProvider>);
      const navigation = await screen.findByRole('navigation', { name: 'التنقل الرئيسي' });
      expect(within(navigation).getByRole('button', { name: 'الفواتير' })).toBeInTheDocument();
      expect(within(navigation).getByRole('button', { name: 'فواتير المبيعات' })).toBeInTheDocument();
      expect(within(navigation).getByRole('button', { name: 'فواتير المشتريات' })).toBeInTheDocument();
      await i18n.changeLanguage('en');
    });
  });
});
