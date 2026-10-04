import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DirectionProvider, MantineProvider, useDirection } from '@mantine/core';
import './i18n';
import './App.css';
import './shared-ui.css';
import './login.css';
import { CompanyProvider, useCompany } from './context/CompanyContext';
import { useAuth } from './context/AuthContext';

type Period = {
  id: string;
  fiscal_year_id: string;
  period_start: string;
  period_end: string;
  status: "open" | "closed";
  ready: boolean;
  disclosed_total: number;
  has_hidden_blockers: boolean;
  blockers: {
    documents: number;
    obligations: number;
    bank_transactions: number;
    vat: number;
    ledger: number;
    assets: number;
    opening_balances: number;
    periodic_adjustments: number;
  };
};
import { FiscalYears } from './components/FiscalYears';
import { Documents } from './components/Documents';
import { BankingWorkspace } from './components/BankingWorkspace';
import { AppShell, Page } from './components/AppShell';
import { EqfalBrandLockup } from './components/EqfalBrand';
import { Home } from './components/Home';
import { Partners } from './components/Partners';
import { Obligations } from './components/Obligations';
import { MonthlyClose } from './components/MonthlyClose';
import { Vat } from './components/Vat';
import { Accounting } from './components/Accounting';
import { Sales } from './components/Sales';
import { Purchases } from './components/Purchases';
import { FixedAssets } from './components/FixedAssets';
import { AssetPolicyOperations } from './components/AssetPolicyOperations';
import { CompanyAccountingProfile } from './components/CompanyAccountingProfile';
import { OpeningBalanceReview } from './components/OpeningBalanceReview';
import { PeriodicAdjustments } from './components/PeriodicAdjustments';
import { AnnualClosing } from './components/AnnualClosing';
import { canStartOperationalDocumentEntry } from './components/operationalEntryCapabilities';
import { eqfalTheme } from './theme';
import { clearContextualQueryState, navigateToQueryState, readQueryParameter, writeQueryParameters } from './navigation/queryState';

type DocumentEntryType = 'purchase' | 'expense' | 'sale';
type DocumentEntryContext = {
  documentType?: DocumentEntryType;
  documentId?: string;
  returnPage: 'purchases' | 'sales';
  counterpartyType: 'supplier' | 'customer';
};

const pages: readonly Page[] = ['home', 'fiscalYears', 'monthlyClose', 'annualClosing', 'vat', 'documents', 'banks', 'partners', 'obligations', 'accounting', 'openingBalances', 'periodicAdjustments', 'sales', 'purchases', 'assets', 'companyProfile'];

function pageFromUrl(): Page {
  return (readQueryParameter('page', { allowedValues: pages }) as Page | null) ?? 'home';
}

function LanguageButton({ className = '' }: { className?: string }) {
  const { t, i18n } = useTranslation();
  return <button className={className} onClick={() => void i18n.changeLanguage(i18n.language === 'ar' ? 'en' : 'ar')}>{t('app.switchLanguage')}</button>;
}

export function MantineDirectionSync() {
  const { i18n } = useTranslation();
  const { setDirection } = useDirection();
  const direction = i18n.language === 'ar' ? 'rtl' : 'ltr';

  useEffect(() => {
    setDirection(direction);
    document.documentElement.dir = direction;
    document.documentElement.lang = i18n.language;
  }, [direction, i18n.language, setDirection]);

  return null;
}

function LoginBrand({ inverse = false }: { inverse?: boolean }) {
  const { t } = useTranslation();
  return <div className="login-brand" aria-hidden="true"><EqfalBrandLockup subtitle={t('app.subtitle')} inverse={inverse} /></div>;
}

function LoginForm() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSubmitting(true); setInvalid(false);
    const data = new FormData(event.currentTarget);
    try { if (!await login(String(data.get('email')), String(data.get('password')))) setInvalid(true); }
    catch { setInvalid(true); } finally { setSubmitting(false); }
  };
  return <main className="login-shell">
    <div className="login-language"><LanguageButton /></div>
    <section className="login-layout" aria-labelledby="login-title">
      <aside className="login-identity">
        <LoginBrand inverse />
        <div className="login-identity-copy">
          <p className="eyebrow">EQFAL</p>
          <h1>{t('app.title')}</h1>
          <p>{t('app.subtitle')}</p>
        </div>
      </aside>
      <div className="login-card">
        <div className="login-card-header">
          <div className="login-card-mobile-brand"><LoginBrand /></div>
          <h2 id="login-title">{t('auth.login')}</h2>
          <p>{t('app.subtitle')}</p>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label>{t('auth.email')}<input name="email" type="email" autoComplete="username" required aria-invalid={invalid || undefined}/></label>
          <label>{t('auth.password')}<input name="password" type="password" autoComplete="current-password" required aria-invalid={invalid || undefined}/></label>
          {invalid && <p role="alert" className="login-error">{t('auth.invalid')}</p>}
          <button className="primary login-submit" disabled={submitting}>{t('auth.login')}</button>
        </form>
      </div>
    </section>
  </main>;
}

function AuthenticatedShell() {
  const { logout, switchCompany, session } = useAuth();
  const [page, setPageState] = useState<Page>(pageFromUrl);
  const [documentEntry, setDocumentEntry] = useState<DocumentEntryContext | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('selectedPeriodId');
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const handleHistoryNavigation = () => { setDocumentEntry(null); setPageState(pageFromUrl()); };
    window.addEventListener('popstate', handleHistoryNavigation);
    return () => window.removeEventListener('popstate', handleHistoryNavigation);
  }, []);
  useEffect(() => {
    try {
      if (selectedPeriodId) {
        localStorage.setItem('selectedPeriodId', selectedPeriodId);
      }
    } catch {
      // localStorage unavailable, continue without persistence
    }
  }, [selectedPeriodId]);
  const navigate = (next: Page) => {
    setDocumentEntry(null);
    setPageState(next);
    clearContextualQueryState('replace');
    writeQueryParameters({ page: next === 'home' ? null : next });
  };
  const navigateToDiscovery = (next: Page, parameters: Record<string, string>) => {
    setDocumentEntry(null);
    navigateToQueryState({ page: next === 'home' ? null : next, ...parameters });
    setPageState(next);
  };
  const openDocumentEntry = (entry: DocumentEntryContext) => {
    setDocumentEntry(entry);
    setPageState('documents');
    clearContextualQueryState('replace');
    writeQueryParameters({ page: 'documents' });
  };
  const startPurchaseEntry = (documentType: 'purchase' | 'expense') => openDocumentEntry({ documentType, returnPage: 'purchases', counterpartyType: 'supplier' });
  const startSalesEntry = () => openDocumentEntry({ documentType: 'sale', returnPage: 'sales', counterpartyType: 'customer' });
  const editPurchaseEntry = (documentId: string) => openDocumentEntry({ documentId, returnPage: 'purchases', counterpartyType: 'supplier' });
  const editSalesEntry = (documentId: string) => openDocumentEntry({ documentId, returnPage: 'sales', counterpartyType: 'customer' });
  const handleSwitch = async (id: string) => { setDocumentEntry(null); clearContextualQueryState(); return switchCompany(id); };
  const handlePeriodChange = (id: string) => { setSelectedPeriodId(id); };
  return <AppShell page={page} setPage={navigate} capabilities={session!.capabilities} email={session!.user.email} onSwitch={handleSwitch} onLogout={logout} periods={periods} selectedPeriodId={selectedPeriodId} onPeriodChange={handlePeriodChange}><CompanyContentForPage page={page} setPage={navigate} navigateToDiscovery={navigateToDiscovery} documentEntry={documentEntry} startPurchaseEntry={startPurchaseEntry} startSalesEntry={startSalesEntry} editPurchaseEntry={editPurchaseEntry} editSalesEntry={editSalesEntry} periods={periods} selectedPeriodId={selectedPeriodId} onPeriodsLoad={setPeriods}/></AppShell>;
}

function CompanyContentForPage({ page, setPage, navigateToDiscovery, documentEntry, startPurchaseEntry, startSalesEntry, editPurchaseEntry, editSalesEntry, periods, selectedPeriodId, onPeriodsLoad }: { page: Page; setPage: (page: Page) => void; navigateToDiscovery: (page: Page, parameters: Record<string, string>) => void; documentEntry: DocumentEntryContext | null; startPurchaseEntry: (type: 'purchase' | 'expense') => void; startSalesEntry: () => void; editPurchaseEntry: (documentId: string) => void; editSalesEntry: (documentId: string) => void; periods: Period[]; selectedPeriodId: string | null; onPeriodsLoad: (p: Period[]) => void }) {
  const { t } = useTranslation(); const { companyKey, activeCompanyId } = useCompany(); const { session, handleUnauthorized } = useAuth();
  if (!activeCompanyId) return <section className="panel"><p role="status" className="shared-state">{t('company.none')}</p></section>;
  if (activeCompanyId !== session?.activeCompanyId) return <section className="panel"><p role="status" className="shared-state">{t('company.switching')}</p></section>;
  const c = session.capabilities;
  const canStartOperationalEntry = canStartOperationalDocumentEntry(c);
  return <div key={companyKey}>
    {page === 'home' && <Home capabilities={c} navigate={setPage} navigateToDiscovery={navigateToDiscovery} onUnauthorized={handleUnauthorized} periods={periods} selectedPeriodId={selectedPeriodId} onPeriodsLoad={onPeriodsLoad}/>}
    {page === 'fiscalYears' && <FiscalYears canView={c.includes('fiscal_year.view')} canCreate={c.includes('fiscal_year.create')} canEdit={c.includes('fiscal_year.edit')} canClose={c.includes('fiscal_year.close')} onUnauthorized={handleUnauthorized}/>}
    {page === 'documents' && <Documents canView={c.includes('document.view')} canUpload={c.includes('document.upload')} canEdit={c.includes('document.edit')} canSubmit={c.includes('document.submit')} canReview={c.includes('document.review')} canApprove={c.includes('document.approve')} canManageCounterparties={Boolean(documentEntry)&&c.includes('counterparty.create')} entryDocumentType={documentEntry?.documentType} entryDocumentId={documentEntry?.documentId} entryReturnPage={documentEntry?.returnPage} entryCounterpartyType={documentEntry?.counterpartyType} onEntryComplete={documentEntry?()=>setPage(documentEntry.returnPage):undefined} onEntryCancel={documentEntry?()=>setPage(documentEntry.returnPage):undefined} onUnauthorized={handleUnauthorized}/>}
    {page === 'banks' && <BankingWorkspace
      canView={c.includes('bank.view')}
      canImport={c.includes('bank.import')}
      canManage={c.includes('bank.account.manage')}
      canMatch={c.includes('bank.match')}
      canReconcile={c.includes('bank.reconcile')}
      canSettle={c.includes('payment.settle')}
      canViewCustody={c.includes('custody.view')}
      canManageCustody={c.includes('custody.manage')}
      canCloseCustody={c.includes('custody.close')}
      onUnauthorized={handleUnauthorized}
    />}
    {page === 'partners' && <Partners canView={c.includes('partner.view')} canCreatePartner={c.includes('partner.create')} canEditPartner={c.includes('partner.edit')} canDisablePartner={c.includes('partner.disable')} canCreateOwnership={c.includes('partner.ownership.create')} canEditOwnership={c.includes('partner.ownership.edit')} canConfirmOwnership={c.includes('partner.ownership.confirm')} onUnauthorized={handleUnauthorized}/>}
    {page === 'companyProfile' && <CompanyAccountingProfile canView={c.includes('company_accounting_profile.view')} canCreate={c.includes('company_accounting_profile.create')} canEdit={c.includes('company_accounting_profile.edit')} canSubmit={c.includes('company_accounting_profile.submit')} canReview={c.includes('company_accounting_profile.review')} canApprove={c.includes('company_accounting_profile.approve')} onUnauthorized={handleUnauthorized}/>}
    {page === 'obligations' && <Obligations canView={c.includes('obligation.view')} canCreateObligation={c.includes('obligation.create')} canEditObligation={c.includes('obligation.edit')} canConfirm={c.includes('obligation.confirm')} canCancelObligation={c.includes('obligation.cancel')} canCreateSettlement={c.includes('obligation.settlement.create')} canRemoveSettlement={c.includes('obligation.settlement.remove')} canCreateCounterparty={c.includes('counterparty.create')} canEditCounterparty={c.includes('counterparty.edit')} canDisableCounterparty={c.includes('counterparty.disable')} onUnauthorized={handleUnauthorized}/>}
    {page === 'sales' && <Sales canView={c.includes('document.view')&&c.includes('obligation.view')} canManage={c.includes('obligation.create')} canCreate={canStartOperationalEntry} canEdit={c.includes('document.edit')} onCreateDocument={startSalesEntry} onEditDocument={editSalesEntry} onUnauthorized={handleUnauthorized}/>}
    {page === 'purchases' && <Purchases canView={c.includes('document.view')&&c.includes('obligation.view')} canManage={c.includes('obligation.create')} canCreate={canStartOperationalEntry} canEdit={c.includes('document.edit')} canCapitalise={c.includes('asset.create')} onCreateDocument={startPurchaseEntry} onEditDocument={editPurchaseEntry} onCapitalise={(id)=>navigateToDiscovery('assets',{assetDocument:id})} onUnauthorized={handleUnauthorized}/>}
    {page === 'monthlyClose' && <MonthlyClose canView={c.includes('monthly_close.view')} canViewFiscalYears={c.includes('fiscal_year.view')} canCreate={c.includes('monthly_close.create')} canClose={c.includes('monthly_close.close')} canReopen={c.includes('monthly_close.reopen')} viewCapabilities={{documents:c.includes('document.view'),obligations:c.includes('obligation.view'),bank:c.includes('bank.view'),vat:c.includes('vat.view'),accounting:c.includes('accounting.view'),assets:c.includes('asset.view'),openingBalances:c.includes('opening_balance.view'),periodicAdjustments:c.includes('periodic_adjustment.view')}} onNavigate={navigateToDiscovery} onUnauthorized={handleUnauthorized} selectedPeriodId={selectedPeriodId}/>}
    {page === 'vat' && <Vat canView={c.includes('vat.view')} canReview={c.includes('vat.review')} canClose={c.includes('vat.close')} canReopen={c.includes('vat.reopen')} onUnauthorized={handleUnauthorized} selectedPeriodId={selectedPeriodId}/>}
    {page === 'accounting' && <Accounting canView={c.includes('accounting.view')} canCreateChart={c.includes('accounting.chart.create')} canEditChart={c.includes('accounting.chart.edit')} canCreateJournal={c.includes('accounting.journal.create')} canEditJournal={c.includes('accounting.journal.edit')} canPost={c.includes('accounting.journal.post')} onUnauthorized={handleUnauthorized}/>}
    {page === 'openingBalances' && <OpeningBalanceReview canView={c.includes('opening_balance.view')} canCreate={c.includes('opening_balance.item.create')} canEdit={c.includes('opening_balance.item.edit')} canDelete={c.includes('opening_balance.item.delete')} canSubmit={c.includes('opening_balance.submit')} canReview={c.includes('opening_balance.review')} canApprove={c.includes('opening_balance.approve')} onUnauthorized={handleUnauthorized}/>}
    {page === 'periodicAdjustments' && <PeriodicAdjustments canView={c.includes('periodic_adjustment.view')} canCreate={c.includes('periodic_adjustment.create')} canEdit={c.includes('periodic_adjustment.edit')} canSubmit={c.includes('periodic_adjustment.submit')} canReview={c.includes('periodic_adjustment.review')} canApprove={c.includes('periodic_adjustment.approve')} canPost={c.includes('periodic_adjustment.post')} onUnauthorized={handleUnauthorized}/>}
    {page === 'annualClosing' && <AnnualClosing canView={c.includes('annual_close.view')} canViewPackage={c.includes('annual_close.package.view')} canCreatePackage={c.includes('annual_close.package.create')} canCreatePackageSnapshot={c.includes('annual_close.package.snapshot.create')} canFinalizePackage={c.includes('annual_close.package.finalize')} canHandoffPackage={c.includes('annual_close.package.handoff')} canReviewPackage={c.includes('annual_close.package.review')} canApprovePackage={c.includes('annual_close.package.approve')} canViewWorkpaper={c.includes('tax_workpaper.view')} canCreateWorkpaper={c.includes('tax_workpaper.create')} canEditWorkpaper={c.includes('tax_workpaper.edit')} canCreateWorkpaperAdjustment={c.includes('tax_workpaper.adjustment.create')} canEditWorkpaperAdjustment={c.includes('tax_workpaper.adjustment.edit')} canDeleteWorkpaperAdjustment={c.includes('tax_workpaper.adjustment.delete')} canSubmitWorkpaper={c.includes('tax_workpaper.submit')} canReview={c.includes('tax_workpaper.review')} canApprove={c.includes('tax_workpaper.approve')} canViewWht={c.includes('wht_review.view')} canCreateWht={c.includes('wht_review.create')} canEditWht={c.includes('wht_review.edit')} canSubmitWht={c.includes('wht_review.submit')} canReviewWht={c.includes('wht_review.review')} onUnauthorized={handleUnauthorized}/>}
    {page === 'assets' && <><AssetPolicyOperations canView={c.includes('asset.view')} canManagePolicy={c.includes('asset.policy.manage')} canCreateEstimate={c.includes('asset.estimate_change.create')} canReviewEstimate={c.includes('asset.estimate_change.review')} canApproveEstimate={c.includes('asset.estimate_change.approve')} onUnauthorized={handleUnauthorized}/><FixedAssets canView={c.includes('asset.view')} canCreate={c.includes('asset.create')} canEdit={c.includes('asset.edit')} canCancel={c.includes('asset.cancel')} canManagePolicy={c.includes('asset.policy.manage')} canApprove={c.includes('asset.approve')} canDispose={c.includes('asset.dispose')} onUnauthorized={handleUnauthorized}/></>}
  </div>;
}

function AppContent() {
  const { t, i18n } = useTranslation();
  const { loading, session } = useAuth();
  const isRtl = i18n.language === 'ar';
  const companies = useMemo(() => (session?.allowedCompanies ?? []).map(company => ({ id: company.id, name: isRtl && company.name_ar ? company.name_ar : company.name })), [session?.allowedCompanies, isRtl]);
  if (loading) return <main className="login-shell login-loading"><LoginBrand /><LanguageButton className="login-loading-language"/><h1>{t('app.title')}</h1><p role="status">{t('app.loading')}</p></main>;
  if (!session) return <LoginForm/>;
  return <CompanyProvider allowedCompanies={companies} initialCompanyId={session.activeCompanyId}><AuthenticatedShell/></CompanyProvider>;
}

export default function App() {
  const { i18n } = useTranslation();
  const direction = i18n.language === 'ar' ? 'rtl' : 'ltr';
  return <DirectionProvider initialDirection={direction}><MantineDirectionSync /><MantineProvider theme={eqfalTheme} defaultColorScheme="light"><AppContent /></MantineProvider></DirectionProvider>;
}
