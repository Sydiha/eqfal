import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './i18n';
import { CompanyProvider } from './context/CompanyContext';
import { CompanySwitcher } from './components/CompanySwitcher';

function AppShell() {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.language === 'ar';

  useEffect(() => {
    document.documentElement.dir  = isRtl ? 'rtl' : 'ltr';
    document.documentElement.lang = i18n.language;
  }, [i18n.language, isRtl]);

  const toggleLanguage = () => {
    const next = i18n.language === 'ar' ? 'en' : 'ar';
    void i18n.changeLanguage(next);
  };

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

      {/* Company switcher — reads allowedCompanies from the nearest Provider */}
      <CompanySwitcher />
    </main>
  );
}

function App() {
  // allowedCompanies starts empty — populated by Auth/Session once available.
  return (
    <CompanyProvider allowedCompanies={[]}>
      <AppShell />
    </CompanyProvider>
  );
}

export default App;
