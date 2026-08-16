import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DirectionProvider, MantineProvider } from '@mantine/core';
import './i18n';
import './App.css';
import { CompanyProvider, useCompany } from './context/CompanyContext';
import { useAuth } from './context/AuthContext';
import { FiscalYears } from './components/FiscalYears';
import { Documents } from './components/Documents';
import { AppShell, Page } from './components/AppShell';
import { Home } from './components/Home';
import { eqfalTheme } from './theme';

function LanguageButton() {
  const { t, i18n } = useTranslation();
  return <button onClick={() => void i18n.changeLanguage(i18n.language === 'ar' ? 'en' : 'ar')}>{t('app.switchLanguage')}</button>;
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
  return <div className="login"><h1>{t('app.title')}</h1><LanguageButton/><form className="login-form" onSubmit={submit}><label>{t('auth.email')}<input name="email" type="email" autoComplete="username" required/></label><label>{t('auth.password')}<input name="password" type="password" autoComplete="current-password" required/></label>{invalid && <p role="alert">{t('auth.invalid')}</p>}<button disabled={submitting}>{t('auth.login')}</button></form></div>;
}

function AuthenticatedShell() {
  const { logout, switchCompany, session } = useAuth();
  const [page, setPage] = useState<Page>('home');
  return <AppShell page={page} setPage={setPage} email={session!.user.email} onSwitch={switchCompany} onLogout={logout}><CompanyContentForPage page={page} setPage={setPage}/></AppShell>;
}

function CompanyContentForPage({ page, setPage }: { page: Page; setPage: (page: Page) => void }) {
  const { t } = useTranslation(); const { companyKey, activeCompanyId } = useCompany(); const { session, handleUnauthorized } = useAuth();
  if (!activeCompanyId) return <section className="panel"><p role="status">{t('company.none')}</p></section>;
  if (activeCompanyId !== session?.activeCompanyId) return <section className="panel"><p role="status">{t('company.switching')}</p></section>;
  const c = session.capabilities;
  return <div key={companyKey}>{page === 'home' && <Home email={session.user.email} canDocuments={c.includes('document.view')} canUpload={c.includes('document.upload')} canFiscalYears={c.includes('fiscal_year.view')} navigate={setPage}/>} {page === 'fiscalYears' && <FiscalYears canView={c.includes('fiscal_year.view')} canManage={c.includes('fiscal_year.manage')} onUnauthorized={handleUnauthorized}/>} {page === 'documents' && <Documents canView={c.includes('document.view')} canUpload={c.includes('document.upload')} canReview={c.includes('document.review')} canApprove={c.includes('document.approve')} onUnauthorized={handleUnauthorized}/>}</div>;
}

function AppContent() {
  const { t, i18n } = useTranslation();
  const { loading, session } = useAuth();
  const isRtl = i18n.language === 'ar';
  useEffect(() => { document.documentElement.dir = isRtl ? 'rtl' : 'ltr'; document.documentElement.lang = i18n.language; }, [i18n.language, isRtl]);
  const companies = useMemo(() => (session?.allowedCompanies ?? []).map(company => ({ id: company.id, name: isRtl && company.name_ar ? company.name_ar : company.name })), [session?.allowedCompanies, isRtl]);
  if (loading) return <main className="login"><h1>{t('app.title')}</h1><LanguageButton/><p role="status">{t('app.loading')}</p></main>;
  if (!session) return <LoginForm/>;
  return <CompanyProvider allowedCompanies={companies} initialCompanyId={session.activeCompanyId}><AuthenticatedShell/></CompanyProvider>;
}

export default function App() {
  const { i18n } = useTranslation();
  const direction = i18n.language === 'ar' ? 'rtl' : 'ltr';
  return <DirectionProvider initialDirection={direction}><MantineProvider theme={eqfalTheme} defaultColorScheme="light"><AppContent /></MantineProvider></DirectionProvider>;
}
