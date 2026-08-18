import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';
import i18n from '../i18n';

describe('authenticated application shell', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: 'u1', email: 'user@example.com' }, allowedCompanies: [{ id: 'co-1', name: 'Company One', name_ar: null }], activeCompanyId: 'co-1', capabilities: ['fiscal_year.view', 'document.view'] }), { status: 200 }))); });
  it('navigates between the three frontend workspaces', async () => {
    render(<AuthProvider><App/></AuthProvider>);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    const navigation = screen.getByRole('navigation', { name: 'Main navigation' });
    const brand = screen.getAllByRole('button', { name: 'Home' }).find((button) => button.classList.contains('sidebar-brand'))!;
    expect(within(brand).getByText('إقفال')).toBeInTheDocument();
    expect(within(brand).getByText('EQFAL')).toBeInTheDocument();
    expect(brand.querySelector('.eqfal-mark svg')).toBeInTheDocument();
    const fiscal = within(navigation).getByRole('button', { name: 'Fiscal Years' });
    const documents = within(navigation).getByRole('button', { name: 'Documents' });
    fireEvent.click(fiscal); expect(fiscal).toHaveAttribute('aria-current', 'page');
    fireEvent.click(documents); expect(documents).toHaveAttribute('aria-current', 'page');
    fireEvent.click(within(navigation).getByRole('button', { name: 'Home' }));
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });
});
