import { ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AppShell as MantineAppShell, Box, Burger, Button, Divider, Group, NavLink, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { CompanySwitcher } from './CompanySwitcher';
import '../mobile.css';

export type Page = 'home' | 'fiscalYears' | 'documents';

const navMarks: Record<Page, string> = { home: '⌂', fiscalYears: '▣', documents: '▤' };

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
      leftSection={<span aria-hidden="true" className="nav-mark">{navMarks[next]}</span>}
      onClick={() => setPage(next)}
    />
  );

  return (
    <MantineAppShell
      className="app-shell"
      header={{ height: 76 }}
      navbar={{ width: 252, breakpoint: 'sm', collapsed: { mobile: !menuOpen } }}
      padding={0}
    >
      <MantineAppShell.Header className="topbar">
        <Group h="100%" wrap="nowrap" gap="md">
          <Burger opened={menuOpen} onClick={toggle} hiddenFrom="sm" size="sm" aria-label={t('nav.openMenu')} />
          <Text className="mobile-brand" fw={800}>{t('app.shortTitle')}</Text>
          <Box className="topbar-spacer" />
          <CompanySwitcher onSwitch={onSwitch} />
          <Button
            className="header-action"
            data-mobile-label={i18n.language === 'ar' ? 'EN' : 'AR'}
            aria-label={t('app.switchLanguage')}
            variant="subtle"
            size="compact-md"
            onClick={() => void i18n.changeLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
          >
            {t('app.switchLanguage')}
          </Button>
          <Divider orientation="vertical" className="top-divider" />
          <Stack gap={0} className="user-summary">
            <Text size="xs" c="dimmed">{t('home.currentUser')}</Text>
            <Text size="sm" fw={600}>{email}</Text>
          </Stack>
          <Button
            className="header-action"
            data-mobile-label="⏻"
            aria-label={t('auth.logout')}
            variant="default"
            size="compact-md"
            onClick={() => void onLogout()}
          >
            {t('auth.logout')}
          </Button>
        </Group>
      </MantineAppShell.Header>

      <MantineAppShell.Navbar className="sidebar" p="lg">
        <UnstyledButton className="sidebar-brand" onClick={() => setPage('home')} aria-label={t('nav.home')}>
          <span className="brand-symbol" aria-hidden="true">E</span>
          <span><Text fw={800} size="lg">{t('app.shortTitle')}</Text><Text size="xs" className="brand-subtitle">{t('app.subtitle')}</Text></span>
        </UnstyledButton>
        <Divider my="xl" className="sidebar-divider" />
        <Text className="nav-caption" tt="uppercase" size="xs" fw={700}>{t('nav.main')}</Text>
        <Stack component="nav" aria-label={t('nav.main')} gap={6} mt="sm">{nav('home')}{nav('fiscalYears')}{nav('documents')}</Stack>
      </MantineAppShell.Navbar>

      <MantineAppShell.Main className="workspace">{children}</MantineAppShell.Main>
    </MantineAppShell>
  );
}
