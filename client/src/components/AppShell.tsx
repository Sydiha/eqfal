import { ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AppShell as MantineAppShell, Box, Burger, Button, Divider, Group, NavLink, Stack, Text, UnstyledButton, Select } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { CompanySwitcher } from './CompanySwitcher';
import { EqfalBrandLockup, EqfalBrandMark } from './EqfalBrand';
import { canShowNavigationPage, type NavigationPage } from './navigationVisibility';
import { useDateContext } from '../context/DateContext';
import { IconHome, IconSales, IconPurchases, IconDocuments, IconBanks, IconObligations, IconAccounting, IconOpeningBalances, IconPeriodicAdjustments, IconFixedAssets, IconVAT, IconMonthlyClose, IconAnnualClose, IconFiscalYears, IconPartners, IconCompanyProfile } from './EqfalIcons';
import '../mobile.css';
import '../visual-polish.css';
import '../brand.css';
import '../shell-corrective.css';

export type Page = NavigationPage;

type IconComponent = React.FC<{ size?: number; stroke?: number; className?: string }>;
type IconName = 'home' | 'sales' | 'purchases' | 'documents' | 'banks' | 'obligations' | 'accounting' | 'openingBalances' | 'periodicAdjustments' | 'fixedAssets' | 'vat' | 'monthlyClose' | 'annualClose' | 'fiscalYears' | 'partners' | 'companyProfile';

const iconMap: Record<IconName, IconComponent> = {
  home: IconHome,
  sales: IconSales,
  purchases: IconPurchases,
  documents: IconDocuments,
  banks: IconBanks,
  obligations: IconObligations,
  accounting: IconAccounting,
  openingBalances: IconOpeningBalances,
  periodicAdjustments: IconPeriodicAdjustments,
  fixedAssets: IconFixedAssets,
  vat: IconVAT,
  monthlyClose: IconMonthlyClose,
  annualClose: IconAnnualClose,
  fiscalYears: IconFiscalYears,
  partners: IconPartners,
  companyProfile: IconCompanyProfile,
};

function ShellIcon({ name }: { name: IconName }) {
  const Icon = iconMap[name];
  return <Icon size={24} stroke={2} className="shell-icon" />;
}

const navIcons: Record<Page, IconName> = { home: 'home', fiscalYears: 'fiscalYears', monthlyClose: 'monthlyClose', annualClosing: 'annualClose', vat: 'vat', documents: 'documents', banks: 'banks', partners: 'partners', obligations: 'obligations', accounting: 'accounting', openingBalances: 'openingBalances', periodicAdjustments: 'periodicAdjustments', sales: 'sales', purchases: 'purchases', assets: 'fixedAssets', companyProfile: 'companyProfile' };

export function AppShell({ page, setPage, capabilities, email, onSwitch, onLogout, children }: { page: Page; setPage: (page: Page) => void; capabilities:string[]; email: string; onSwitch: (id: string) => Promise<boolean>; onLogout: () => Promise<void>; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const [menuOpen, { toggle, close }] = useDisclosure(false);
  const { selectedFiscalYearId, availableFiscalYears, selectedPeriodId, availablePeriodsForSelectedYear, periodMode, onSelectFiscalYear, onSelectPeriod } = useDateContext();
  useEffect(close, [page, close]);
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

  const isAr = i18n.language === 'ar';
  const mobileLogoutLabel = i18n.language === 'ar' ? 'خروج' : 'Log out';
  const userInitial = email.trim().charAt(0).toUpperCase() || 'U';
  const groupLabels = i18n.language === 'ar'
    ? { operations: 'التشغيل', accounting: 'المحاسبة', administration: 'الإدارة' }
    : { operations: 'Operations', accounting: 'Accounting', administration: 'Administration' };

  return (
    <MantineAppShell
      className="app-shell app-shell--v2"
      header={{ height: 54 }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !menuOpen } }}
      layout="alt"
      padding={0}
    >
      <MantineAppShell.Header className="topbar">
        <Group h="100%" wrap="nowrap" gap={0} className="topbar-layout">
          <Burger opened={menuOpen} onClick={toggle} hiddenFrom="sm" size="sm" aria-label={t('nav.openMenu')} />
          <span className="mobile-brand" aria-label="إقفال | EQFAL"><EqfalBrandMark compact /></span>
          <Stack gap={0} className="page-context">
            <Text size="xs" className="page-context-label">{t('app.shortTitle')}</Text>
            <Text className="page-context-title" fw={750}>{pageLabel(page)}</Text>
          </Stack>
          <Group gap={8} wrap="nowrap" className="topbar-context">
            {canShowNavigationPage('documents', capabilities) && (
              <button type="button" className="topbar-icon-button" aria-label={isAr ? 'بحث في المستندات' : 'Search documents'} onClick={() => setPage('documents')}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              </button>
            )}
            <span className="topbar-company-group"><CompanySwitcher onSwitch={onSwitch} /></span>

            {/* Fiscal Year Selector */}
            {availableFiscalYears && availableFiscalYears.length > 0 && (
              <Select
                aria-label={isAr ? 'السنة المالية' : 'Fiscal Year'}
                value={selectedFiscalYearId || ''}
                onChange={(value) => value && onSelectFiscalYear(value)}
                data={availableFiscalYears.map(fy => ({
                  value: fy.id,
                  label: fy.name
                }))}
                placeholder={isAr ? 'اختر السنة' : 'Select Year'}
                searchable
                clearable={false}
                size="xs"
                className="topbar-select-wrap"
                classNames={{ input: 'topbar-select' }}
              />
            )}

            {/* Period Selector */}
            {availablePeriodsForSelectedYear && availablePeriodsForSelectedYear.length > 0 && (
              <Select
                aria-label={isAr ? 'الفترة' : 'Period'}
                value={periodMode === 'all' ? 'all' : (selectedPeriodId || '')}
                onChange={(value) => {
                  if (value === 'all') {
                    onSelectPeriod('', 'all');
                  } else if (value) {
                    onSelectPeriod(value, 'specific');
                  }
                }}
                data={[
                  { value: 'all', label: isAr ? 'السنة كاملة' : 'All Periods in Year' },
                  ...availablePeriodsForSelectedYear.map(period => ({
                    value: period.id,
                    label: `${new Date(period.period_start).toLocaleDateString(isAr ? 'ar-u-ca-gregory-nu-latn' : 'en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`
                  }))
                ]}
                placeholder={isAr ? 'اختر الفترة' : 'Select Month'}
                searchable
                clearable={false}
                size="xs"
                className="topbar-select-wrap"
                classNames={{ input: 'topbar-select' }}
              />
            )}
          </Group>
          <Box className="topbar-spacer" />
          <Group gap={10} wrap="nowrap" className="topbar-user-group">
            <button type="button" className="topbar-icon-button topbar-icon-button--round" aria-label={isAr ? 'المهام بانتظارك' : 'Tasks waiting for you'} onClick={() => setPage('home')}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
            </button>
            <Group gap={8} wrap="nowrap" className="user-summary">
              <span className="user-avatar" aria-hidden="true">{userInitial}</span>
              <Stack gap={0} className="user-copy">
                <Text size="sm" fw={650}>{email}</Text>
                <Text size="xs" c="dimmed">{t('home.currentUser')}</Text>
              </Stack>
            </Group>
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
        <Text className="sidebar-compliance-footer">{i18n.language === 'ar' ? 'EQFAL — نظام إدارة الإقفال المالي' : 'EQFAL — Financial Close Management'}</Text>
      </MantineAppShell.Navbar>

      <MantineAppShell.Main className="eqfal-workspace">
        <div className="workspace-content">{children}</div>
      </MantineAppShell.Main>
    </MantineAppShell>
  );
}
