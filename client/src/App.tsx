import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DirectionProvider, MantineProvider, useDirection } from '@mantine/core';
import './i18n';
import './App.css';
import './shared-ui.css';
import './login.css';
import { CompanyProvider, useCompany } from './context/CompanyContext';
import { useAuth } from './context/AuthContext';
import { FiscalYears } from './components/FiscalYears';
import { Documents } from './components/Documents';
import { BankingWorkspace } from './components/BankingWorkspace';
import { AppShell, Page } from './components/AppShell';
import { Home } from './components/Home';
import { Partners } from './components/Partners';
import { eqfalTheme } from './theme';

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

function LoginBrand() {
  const { t } = useTranslation();
  return <div className="login-brand" aria-hidden="true">
    <div className="login-brand-mark">إ</div>
    <div>
      <p className="login-brand-name">{t('app.shortTitle')} <span>EQFAL</span></p>
      <p className="login-brand-subtitle">{t('app.subtitle')}</p>
    </div>
  </div>;
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
        <LoginBrand />
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
  const [page, setPage] = useState<Page>('home');
  return <AppShell page={page} setPage={setPage} email={session!.user.email} onSwitch={switchCompany} onLogout={logout}><CompanyContentForPage page={page} setPage={setPage}/></AppShell>;
}

function CompanyContentForPage({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  const { t } = useTranslation(); const { companyKey, activeCompanyId } = useCompany(); const { session, handleUnauthorized } = useAuth();
  if (!activeCompanyId) return <section className="panel"><p role="status" className="shared-state">{t('company.none')}</p></section>;
  if (activeCompanyId !== session?.activeCompanyId) return <section className="panel"><p role="status" className="shared-state">{t('company.switching')}</p></section>;
  const c = session.capabilities;
  return <div key={companyKey}>
    {page === 'home' && <Home email={session.user.email} canDocuments={c.includes('document.view')} canUpload={c.includes('document.upload')} canFiscalYears={c.includes('fiscal_year.view')} navigate={setPage}/>}
    {page === 'fiscalYears' && <FiscalYears canView={c.includes('fiscal_year.view')} canManage={c.includes('fiscal_year.manage')} onUnauthorized={handleUnauthorized}/>}
    {page === 'documents' && <Documents canView={c.includes('document.view')} canUpload={c.includes('document.upload')} canReview={c.includes('document.review')} canApprove={c.includes('document.approve')} onUnauthorized={handleUnauthorized}/>}
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
    {page === 'partners' && <Partners canView={c.includes('partner.view')} canManage={c.includes('partner.manage')} onUnauthorized={handleUnauthorized}/>}
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
