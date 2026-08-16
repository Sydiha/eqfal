import { ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppShell as MantineAppShell,
  Box,
  Burger,
  Button,
  Divider,
  Group,
  NavLink,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { CompanySwitcher } from './CompanySwitcher';

export type Page = 'home' | 'fiscalYears' | 'documents';

const navMarks: Record<Page, string> = { home: '⌂', fiscalYears: '▣', documents: '▤' };

interface AppShellProps {
  page: Page;
  setPage: (page: Page) => void;
  email: string;
  onSwitch: (id: string) => Promise<boolean>;
  onLogout: () => Promise<void>;
  children: ReactNode;
}

export function AppShell({ page, setPage, email, onSwitch, onLogout, children }: AppShellProps) {
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
      header={{ height: 68 }}
      navbar={{ width: 232, breakpoint: 'sm', collapsed: { mobile: !menuOpen } }}
      layout="alt"
      padding={0}
    >
      <MantineAppShell.Header className="topbar">
        <Group h="100%" wrap="nowrap" gap="md" className="topbar-content">
          <Burger opened={menuOpen} onClick={toggle} hiddenFrom="sm" size="sm" aria-label={t('nav.openMenu')} />
          <Text className="mobile-brand" fw={800}>{t('app.shortTitle')}</Text>
          <Box className="topbar-spacer" />
          <CompanySwitcher onSwitch={onSwitch} />
          <Button
            className="language-switch"
            variant="subtle"
            size="compact-md"
            onClick={() => void i18n.changeLanguage(i18n.language === 'ar' ? 'en' : 'ar')}
          >
            {t('app.switchLanguage')}
          </Button>
        </Group>
      </MantineAppShell.Header>

      <MantineAppShell.Navbar className="sidebar" p="md">
        <MantineAppShell.Section>
          <UnstyledButton className="sidebar-brand" onClick={() => setPage('home')} aria-label={t('nav.home')}>
            <span className="brand-symbol" aria-hidden="true">E</span>
            <span>
              <Text fw={800} size="lg">{t('app.shortTitle')}</Text>
              <Text size="xs" className="brand-subtitle">{t('app.subtitle')}</Text>
            </span>
          </UnstyledButton>
          <Divider my="lg" className="sidebar-divider" />
          <Text className="nav-caption" tt="uppercase" size="xs" fw={700}>{t('nav.main')}</Text>
        </MantineAppShell.Section>
        <MantineAppShell.Section grow component="nav" aria-label={t('nav.main')} mt="xs">
          <Stack gap={4}>{nav('home')}{nav('fiscalYears')}{nav('documents')}</Stack>
        </MantineAppShell.Section>
        <MantineAppShell.Section className="sidebar-footer">
          <Divider mb="md" className="sidebar-divider" />
          <Stack gap="sm">
            <Box className="user-summary">
              <Text size="xs" c="dimmed">{t('home.currentUser')}</Text>
              <Text size="sm" fw={600} title={email}>{email}</Text>
            </Box>
            <Button fullWidth variant="default" onClick={() => void onLogout()}>{t('auth.logout')}</Button>
          </Stack>
        </MantineAppShell.Section>
      </MantineAppShell.Navbar>

      <MantineAppShell.Main className="workspace">
        <div className="workspace-content">{children}</div>
      </MantineAppShell.Main>
    </MantineAppShell>
  );
}
