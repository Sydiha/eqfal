import { ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AppShell as MantineAppShell, Box, Burger, Button, Divider, Group, NavLink, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { CompanySwitcher } from './CompanySwitcher';
import { EqfalBrandLockup, EqfalBrandMark } from './EqfalBrand';
import '../mobile.css';
import '../visual-polish.css';
import '../brand.css';

export type Page = 'home' | 'fiscalYears' | 'documents' | 'banks' | 'partners' | 'obligations';

type IconName = 'home' | 'calendar' | 'document' | 'bank' | 'partners' | 'obligations';

function ShellIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="M3.5 10.5 12 3l8.5 7.5"/><path d="M5.5 9.5V21h13V9.5"/><path d="M9.5 21v-6h5v6"/></>,
    calendar: <><rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M7.5 3v5M16.5 3v5M3.5 10h17"/><path d="M8 14h2M14 14h2M8 17.5h2M14 17.5h2"/></>,
    document: <><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5V8h4M8 12h8M8 16h8"/></>,
    bank: <><path d="M3 9h18M5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 18h18M2 21h20M12 3 3 7h18L12 3Z"/></>,
    partners: <><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2"/><path d="M3 20c0-4 2-6 6-6s6 2 6 6M15 15c3 0 5 2 5 5"/></>,
    obligations: <><path d="M5 4h14v16H5zM8 9h8M8 13h8M8 17h5"/></>,
  };
  return <svg className="shell-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const navIcons: Record<Page, IconName> = { home: 'home', fiscalYears: 'calendar', documents: 'document', banks: 'bank', partners: 'partners', obligations:'obligations' };

export function AppShell({ page, setPage, email, onSwitch, onLogout, children }: { page: Page; setPage: (page: Page) => void; email: string; onSwitch: (id: string) => Promise<boolean>; onLogout: () => Promise<void>; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const [menuOpen, { toggle, close }] = useDisclosure(false);
  useEffect(close, [page, close]);

  const nav = (next: Page) => (
    <NavLink
      component="button"
      className="eqfal-nav-link"
      active={page === next}
      aria-current={page === next ? 'page' : undefined}
      label={t(`nav.${next}`)}
      leftSection={<span aria-hidden="true" className="nav-icon"><ShellIcon name={navIcons[next]} /></span>}
      onClick={() => setPage(next)}
    />
  );

  const mobileLogoutLabel = i18n.language === 'ar' ? 'خروج' : 'Log out';
  const userInitial = email.trim().charAt(0).toUpperCase() || 'U';

  return (
    <MantineAppShell
      className="app-shell"
      header={{ height: 72 }}
      navbar={{ width: 256, breakpoint: 'sm', collapsed: { mobile: !menuOpen } }}
      layout="alt"
      padding={0}
    >
      <MantineAppShell.Header className="topbar">
        <Group h="100%" wrap="nowrap" gap="md">
          <Burger opened={menuOpen} onClick={toggle} hiddenFrom="sm" size="sm" aria-label={t('nav.openMenu')} />
          <span className="mobile-brand" aria-label="إقفال | EQFAL"><EqfalBrandMark compact /></span>
          <Stack gap={0} className="page-context">
            <Text size="xs" className="page-context-label">{t('app.shortTitle')}</Text>
            <Text className="page-context-title" fw={750}>{t(`nav.${page}`)}</Text>
          </Stack>
          <Box className="topbar-spacer" />
          <CompanySwitcher onSwitch={onSwitch} />
          <Button
            className="header-action language-action"
            aria-label={t('app.switchLanguage')}
            variant="subtle"
            size="compact-md"
            onClick={() => void i18n.changeLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
          >
            <span className="desktop-action-label">{i18n.language === 'ar' ? 'EN' : 'AR'}</span>
            <span className="mobile-action-label" aria-hidden="true">{i18n.language === 'ar' ? 'EN' : 'AR'}</span>
          </Button>
          <Divider orientation="vertical" className="top-divider" />
          <Group gap="sm" wrap="nowrap" className="user-summary">
            <span className="user-avatar" aria-hidden="true">{userInitial}</span>
            <Stack gap={0} className="user-copy">
              <Text size="xs" c="dimmed">{t('home.currentUser')}</Text>
              <Text size="sm" fw={650}>{email}</Text>
            </Stack>
          </Group>
          <Button
            className="header-action logout-action"
            aria-label={t('auth.logout')}
            variant="subtle"
            size="compact-md"
            onClick={() => void onLogout()}
          >
            <span className="desktop-action-label">{t('auth.logout')}</span>
            <span className="mobile-action-label" aria-hidden="true">{mobileLogoutLabel}</span>
          </Button>
        </Group>
      </MantineAppShell.Header>

      <MantineAppShell.Navbar className="sidebar" p="lg">
        <UnstyledButton className="sidebar-brand" onClick={() => setPage('home')} aria-label={t('nav.home')}>
          <EqfalBrandLockup subtitle={t('app.subtitle')} inverse />
        </UnstyledButton>
        <Divider my="xl" className="sidebar-divider" />
        <Text className="nav-caption" size="xs" fw={700}>{t('nav.main')}</Text>
        <Stack component="nav" aria-label={t('nav.main')} gap={6} mt="sm">{nav('home')}{nav('fiscalYears')}{nav('documents')}{nav('banks')}{nav('partners')}{nav('obligations')}</Stack>
      </MantineAppShell.Navbar>

      <MantineAppShell.Main className="eqfal-workspace">
        <div className="workspace-content">{children}</div>
      </MantineAppShell.Main>
    </MantineAppShell>
  );
}
