import { ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CompanySwitcher } from './CompanySwitcher';

export type Page = 'home' | 'fiscalYears' | 'documents';
export function AppShell({ page, setPage, email, onSwitch, onLogout, children }: { page: Page; setPage: (page: Page) => void; email: string; onSwitch: (id: string) => Promise<boolean>; onLogout: () => Promise<void>; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [page]);
  const nav = (next: Page) => <button className="nav-link" aria-current={page === next ? 'page' : undefined} onClick={() => setPage(next)}>{t(`nav.${next}`)}</button>;
  return <div className="app-shell">
    <header className="topbar"><button className="menu-trigger" aria-label={t('nav.openMenu')} aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)}>☰</button><div className="brand">{t('app.title')}</div><div className="top-actions"><CompanySwitcher onSwitch={onSwitch}/><button onClick={() => void i18n.changeLanguage(i18n.language === 'ar' ? 'en' : 'ar')}>{t('app.switchLanguage')}</button><span className="user-email">{email}</span><button onClick={() => void onLogout()}>{t('auth.logout')}</button></div></header>
    {menuOpen && <button className="drawer-scrim" aria-label={t('common.close')} onClick={() => setMenuOpen(false)}/>}<aside className={`sidebar ${menuOpen ? 'open' : ''}`}><div className="sidebar-brand">{t('app.shortTitle')}</div><nav aria-label={t('nav.main')}>{nav('home')}{nav('fiscalYears')}{nav('documents')}</nav></aside>
    <main className="workspace">{children}</main>
  </div>;
}
