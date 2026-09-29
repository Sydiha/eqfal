import { ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppShell as MantineAppShell, Box, Burger, Button, Divider, Group, NavLink, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { CompanySwitcher } from './CompanySwitcher';
import { useCompany } from '../context/CompanyContext';
import { EqfalBrandLockup, EqfalBrandMark } from './EqfalBrand';
import { canShowNavigationPage, type NavigationPage } from './navigationVisibility';
import '../mobile.css';
import '../visual-polish.css';
import '../brand.css';
import '../shell-corrective.css';

export type Page = NavigationPage;

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

const navIcons: Record<Page, IconName> = { home: 'home', fiscalYears: 'calendar', monthlyClose:'calendar', annualClosing:'calendar', vat:'document', documents: 'document', banks: 'bank', partners: 'partners', obligations:'obligations', accounting:'document',openingBalances:'document',periodicAdjustments:'document',sales:'document',purchases:'document',assets:'document',companyProfile:'document' };

export function AppShell({ page, setPage, capabilities, email, onSwitch, onLogout, children }: { page: Page; setPage: (page: Page) => void; capabilities:string[]; email: string; onSwitch: (id: string) => Promise<boolean>; onLogout: () => Promise<void>; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const [menuOpen, { toggle, close }] = useDisclosure(false);
  const { activeCompanyId, allowedCompanies } = useCompany();
  const activeCompany = allowedCompanies.find(company => company.id === activeCompanyId);
  const [fiscalYearLabel, setFiscalYearLabel] = useState<string>('—');
  const [periodLabel, setPeriodLabel] = useState<string>('—');
  useEffect(close, [page, close]);
  useEffect(() => {
    let cancelled = false;
    const loadContext = async () => {
      try {
        const [yearsResponse, periodsResponse] = await Promise.all([
          fetch('/api/fiscal-years', { credentials: 'same-origin' }),
          fetch('/api/monthly-close-periods', { credentials: 'same-origin' }),
        ]);
        if (yearsResponse.ok) {
          const body = await yearsResponse.json() as { fiscalYears?: Array<{ name: string; status: string }> };
          const years = Array.isArray(body.fiscalYears) ? body.fiscalYears : [];
          const current = years.find(year => year.status === 'open') ?? years[0];
          if (!cancelled && current) setFiscalYearLabel(current.name);
        }
        if (periodsResponse.ok) {
          const body = await periodsResponse.json() as { periods?: Array<{ period_start: string; status: string }> };
          const periods = Array.isArray(body.periods) ? body.periods : [];
          const current = periods.find(period => period.status === 'open') ?? periods[0];
          if (!cancelled && current) {
            const date = new Date(`${current.period_start}T00:00:00`);
            setPeriodLabel(new Intl.DateTimeFormat(i18n.language, { month: 'long', year: 'numeric' }).format(date));
          }
        }
      } catch { /* Context pills fail closed to em dash; page functionality remains available. */ }
    };
    void loadContext();
    return () => { cancelled = true; };
  }, [activeCompanyId, i18n.language]);
  const pageLabel=(next:Page)=>next==='companyProfile'?(i18n.language==='ar'?'الملف المحاسبي والضريبي':'Accounting & Tax Profile'):next==='openingBalances'?(i18n.language==='ar'?'الأرصدة الافتتاحية':'Opening Balances'):next==='periodicAdjustments'?(i18n.language==='ar'?'الاستحقاقات والمقدمات':'Accruals & Prepayments'):t(`nav.${next}`);

  const nav = (next: Page) => (
    <NavLink
      component="button"
      className="eqfal-nav-link"
      active={page === next}
      aria-current={page === next ? 'page' : undefined}
      label={pageLabel(next)}
      leftSection={<span aria-hidden="true" className="nav-icon"><ShellIcon name={navIcons[next]} /></span>}
      styles={{ label: { whiteSpace: 'normal', lineHeight: 1.35 } }}
      onClick={() => setPage(next)}
    />
  );

  const navGroup = (label: string, items: ReactNode) => (
    <Stack gap={4} className="eqfal-nav-group">
      <Text className="nav-caption eqfal-nav-group__label" size="xs" fw={700}>{label}</Text>
      <Stack gap={4}>{items}</Stack>
    </Stack>
  );

  const mobileLogoutLabel = i18n.language === 'ar' ? 'خروج' : 'Log out';
  const userInitial = email.trim().charAt(0).toUpperCase() || 'U';
  const groupLabels = i18n.language === 'ar'
    ? { operations: 'التشغيل', accounting: 'المحاسبة', administration: 'الإدارة' }
    : { operations: 'Operations', accounting: 'Accounting', administration: 'Administration' };

  return (
    <MantineAppShell
      className="app-shell app-shell--v2"
      header={{ height: 60 }}
      navbar={{ width: 260, breakpoint: 'sm', collapsed: { mobile: !menuOpen } }}
      layout="alt"
      padding={0}
    >
      <MantineAppShell.Header className="topbar">
        <Group h="100%" wrap="nowrap" gap="md">
          <Burger opened={menuOpen} onClick={toggle} hiddenFrom="sm" size="sm" aria-label={t('nav.openMenu')} />
          <span className="mobile-brand" aria-label="إقفال | EQFAL"><EqfalBrandMark compact /></span>
          <div className="figma-topbar-left">
            <button type="button" className="figma-notification" aria-label={i18n.language === 'ar' ? 'التنبيهات' : 'Notifications'}><span aria-hidden="true">♧</span></button>
            <div className="figma-profile">
              <span className="user-avatar" aria-hidden="true">{userInitial}</span>
              <span className="figma-profile-copy"><strong>{email}</strong><small>{t('home.currentUser')}</small></span>
            </div>
            <Button className="figma-utility" variant="subtle" size="compact-xs" onClick={() => void i18n.changeLanguage(i18n.language === 'ar' ? 'en' : 'ar')}>{i18n.language === 'ar' ? 'EN' : 'AR'}</Button>
            <Button className="figma-utility" variant="subtle" size="compact-xs" onClick={() => void onLogout()}>{mobileLogoutLabel}</Button>
          </div>
          <Box className="topbar-spacer" />
          <div className="figma-topbar-context">
            <button type="button" className="figma-search" aria-label={i18n.language === 'ar' ? 'بحث' : 'Search'}>⌕</button>
            <div className="figma-company-pill" title={activeCompany?.name ?? ''}><CompanySwitcher onSwitch={onSwitch} /></div>
            <button type="button" className="figma-context-pill" onClick={() => setPage('fiscalYears')}><span aria-hidden="true">▣</span><strong>{i18n.language === 'ar' ? `السنة المالية ${fiscalYearLabel}` : `Fiscal year ${fiscalYearLabel}`}</strong><span aria-hidden="true">⌄</span></button>
            <button type="button" className="figma-context-pill figma-context-pill--period" onClick={() => setPage('monthlyClose')}><span aria-hidden="true">◷</span><strong>{periodLabel}</strong><span aria-hidden="true">⌄</span></button>
          </div>
        </Group>
      </MantineAppShell.Header>

      <MantineAppShell.Navbar className="sidebar" p="md">
        <UnstyledButton className="sidebar-brand" onClick={() => setPage('home')} aria-label={t('nav.home')}>
          <EqfalBrandLockup subtitle={t('app.subtitle')} inverse />
        </UnstyledButton>
        <Divider my="lg" className="sidebar-divider" />
        <Stack component="nav" aria-label={t('nav.main')} gap="lg" className="eqfal-nav-groups">
          <Stack gap={4}>{nav('home')}</Stack>
          {navGroup(groupLabels.operations, <>{canShowNavigationPage('sales', capabilities)&&nav('sales')}{canShowNavigationPage('purchases', capabilities)&&nav('purchases')}{canShowNavigationPage('documents', capabilities)&&nav('documents')}{canShowNavigationPage('banks', capabilities)&&nav('banks')}{canShowNavigationPage('obligations', capabilities)&&nav('obligations')}</>)}
          {navGroup(groupLabels.accounting, <>{canShowNavigationPage('accounting', capabilities)&&nav('accounting')}{canShowNavigationPage('annualClosing', capabilities)&&nav('annualClosing')}{canShowNavigationPage('openingBalances', capabilities)&&nav('openingBalances')}{canShowNavigationPage('periodicAdjustments', capabilities)&&nav('periodicAdjustments')}{canShowNavigationPage('assets', capabilities)&&nav('assets')}{canShowNavigationPage('vat', capabilities)&&nav('vat')}{canShowNavigationPage('monthlyClose', capabilities)&&nav('monthlyClose')}{canShowNavigationPage('fiscalYears', capabilities)&&nav('fiscalYears')}</>)}
          {navGroup(groupLabels.administration, <>{canShowNavigationPage('partners', capabilities)&&nav('partners')}{canShowNavigationPage('companyProfile', capabilities)&&nav('companyProfile')}</>)}
        </Stack>
      </MantineAppShell.Navbar>

      <MantineAppShell.Main className="eqfal-workspace">
        <div className="workspace-content">{children}</div>
      </MantineAppShell.Main>
    </MantineAppShell>
  );
}
