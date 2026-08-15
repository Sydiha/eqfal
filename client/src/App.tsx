import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './i18n';
import './App.css';
import { CompanyProvider, useCompany } from './context/CompanyContext';
import { useAuth } from './context/AuthContext';
import { CompanySwitcher } from './components/CompanySwitcher';
import { FiscalYears } from './components/FiscalYears';
import { Documents } from './components/Documents';

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

function CompanyContent() {
  const { t } = useTranslation();
  const { companyKey, activeCompanyId } = useCompany();
  const { session, handleUnauthorized } = useAuth();
  if (!activeCompanyId) return <section className="panel"><p role="status">{t('company.none')}</p></section>;
  if (activeCompanyId !== session?.activeCompanyId) {
    return <section className="panel"><p role="status">{t('company.switching')}</p></section>;
  }
  const capabilities = session?.capabilities ?? [];
  return (
    <div key={companyKey}>
      <FiscalYears
        canView={capabilities.includes('fiscal_year.view')}
        canManage={capabilities.includes('fiscal_year.manage')}
        onUnauthorized={handleUnauthorized}
      />
      <Documents
        canView={capabilities.includes('document.view')}
        canUpload={capabilities.includes('document.upload')}
        canReview={capabilities.includes('document.review')}
        canApprove={capabilities.includes('document.approve')}
        onUnauthorized={handleUnauthorized}
      />
    </div>
  );
}

function AuthenticatedShell() {
  const { t } = useTranslation();
  const { logout, switchCompany } = useAuth();
  return <div className="app"><header className="topbar"><h1 className="brand">{t('app.title')}</h1><div className="top-actions"><CompanySwitcher onSwitch={switchCompany}/><LanguageButton/><button onClick={() => void logout()}>{t('auth.logout')}</button></div></header><main className="content"><CompanyContent/></main></div>;
}

export default function App() {
  const { t, i18n } = useTranslation();
  const { loading, session } = useAuth();
  const isRtl = i18n.language === 'ar';
  useEffect(() => { document.documentElement.dir = isRtl ? 'rtl' : 'ltr'; document.documentElement.lang = i18n.language; }, [i18n.language, isRtl]);
  const companies = useMemo(() => (session?.allowedCompanies ?? []).map(company => ({ id: company.id, name: isRtl && company.name_ar ? company.name_ar : company.name })), [session?.allowedCompanies, isRtl]);
  if (loading) return <main className="login"><h1>{t('app.title')}</h1><LanguageButton/><p role="status">{t('app.loading')}</p></main>;
  if (!session) return <LoginForm/>;
  return <CompanyProvider allowedCompanies={companies} initialCompanyId={session.activeCompanyId}><AuthenticatedShell/></CompanyProvider>;
}
