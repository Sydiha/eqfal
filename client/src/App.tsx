import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './i18n';
import { CompanyProvider } from './context/CompanyContext';
import { useAuth } from './context/AuthContext';
import { CompanySwitcher } from './components/CompanySwitcher';

function LanguageButton() {
  const { t, i18n } = useTranslation();
  const toggleLanguage = () => {
    const next = i18n.language === 'ar' ? 'en' : 'ar';
    void i18n.changeLanguage(next);
  };

  return (
    <button
      onClick={toggleLanguage}
      style={{
        padding: '0.5rem 1.25rem',
        fontSize: '0.9rem',
        cursor: 'pointer',
        borderRadius: '6px',
        border: '1px solid #ccc',
      }}
    >
      {t('app.switchLanguage')}
    </button>
  );
}

function LoginForm() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setInvalid(false);
    try {
      const ok = await login(email, password);
      if (!ok) setInvalid(true);
    } catch {
      setInvalid(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: '0.75rem', width: 'min(100%, 360px)', marginTop: '1.5rem' }}>
      <label style={{ display: 'grid', gap: '0.3rem', textAlign: 'start' }}>
        <span>{t('auth.email')}</span>
        <input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          style={{ padding: '0.65rem', border: '1px solid #ccc', borderRadius: '6px' }}
        />
      </label>
      <label style={{ display: 'grid', gap: '0.3rem', textAlign: 'start' }}>
        <span>{t('auth.password')}</span>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          style={{ padding: '0.65rem', border: '1px solid #ccc', borderRadius: '6px' }}
        />
      </label>
      {invalid && <p role="alert" style={{ margin: 0 }}>{t('auth.invalid')}</p>}
      <button type="submit" disabled={submitting} style={{ padding: '0.65rem', cursor: submitting ? 'wait' : 'pointer' }}>
        {t('auth.login')}
      </button>
    </form>
  );
}

function AuthenticatedShell() {
  const { t } = useTranslation();
  const { logout, switchCompany } = useAuth();

  return (
    <>
      <CompanySwitcher onSwitch={switchCompany} />
      <button onClick={() => void logout()} style={{ marginTop: '1rem', padding: '0.5rem 1rem' }}>
        {t('auth.logout')}
      </button>
    </>
  );
}

function App() {
  const { t, i18n } = useTranslation();
  const { loading, session } = useAuth();
  const isRtl = i18n.language === 'ar';

  useEffect(() => {
    document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
    document.documentElement.lang = i18n.language;
  }, [i18n.language, isRtl]);

  const allowedCompanies = useMemo(
    () => (session?.allowedCompanies ?? []).map((company) => ({
      id: company.id,
      name: isRtl && company.name_ar ? company.name_ar : company.name,
    })),
    [session?.allowedCompanies, isRtl],
  );

  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        padding: '1rem',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: 'clamp(1.25rem, 5vw, 2rem)', margin: '0 0 1.5rem' }}>
        {t('app.title')}
      </h1>
      <LanguageButton />

      {loading ? (
        <p role="status">{t('app.loading')}</p>
      ) : session ? (
        <CompanyProvider
          allowedCompanies={allowedCompanies}
          initialCompanyId={session.activeCompanyId}
        >
          <AuthenticatedShell />
        </CompanyProvider>
      ) : (
        <LoginForm />
      )}
    </main>
  );
}

export default App;
