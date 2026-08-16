import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useCompany } from '../context/CompanyContext';

type ActionIconName = 'documents' | 'upload' | 'calendar';

function ActionIcon({ name }: { name: ActionIconName }) {
  const paths: Record<ActionIconName, ReactNode> = {
    documents: <><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5V8h4M8 12h8M8 16h8"/></>,
    upload: <><path d="M12 16V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 14v5a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-5"/></>,
    calendar: <><rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M7.5 3v5M16.5 3v5M3.5 10h17"/><path d="M8 14h2M14 14h2M8 17.5h2M14 17.5h2"/></>,
  };
  return <svg className="action-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function Home({ email, canDocuments, canUpload, canFiscalYears, navigate }: { email: string; canDocuments: boolean; canUpload: boolean; canFiscalYears: boolean; navigate: (page: 'documents' | 'fiscalYears') => void }) {
  const { t } = useTranslation();
  const { activeCompany } = useCompany();

  const actions = [
    canDocuments && { key: 'documents', icon: 'documents' as const, title: t('documents.title'), description: t('home.documentsDescription'), cta: t('home.openDocuments'), page: 'documents' as const },
    canUpload && { key: 'upload', icon: 'upload' as const, title: t('documents.upload'), description: t('home.uploadDescription'), cta: t('home.uploadDocument'), page: 'documents' as const, featured: true },
    canFiscalYears && { key: 'fiscalYears', icon: 'calendar' as const, title: t('fiscalYears.title'), description: t('home.fiscalYearsDescription'), cta: t('home.openFiscalYears'), page: 'fiscalYears' as const },
  ].filter(Boolean) as Array<{ key: string; icon: ActionIconName; title: string; description: string; cta: string; page: 'documents' | 'fiscalYears'; featured?: boolean }>;

  return (
    <section className="home-modern" aria-labelledby="home-title">
      <header className="home-hero">
        <div className="home-hero-copy">
          <p className="home-eyebrow">{t('home.workspace')}</p>
          <h1 id="home-title">{t('home.welcome')}</h1>
          <p className="home-intro">{t('home.context')}</p>
        </div>
        <div className="home-context" aria-label={t('home.workspace')}>
          <div className="home-context-item">
            <span>{t('company.label')}</span>
            <strong>{activeCompany?.name ?? '—'}</strong>
          </div>
          <span className="home-context-separator" aria-hidden="true" />
          <div className="home-context-item home-user-context">
            <span>{t('home.currentUser')}</span>
            <strong>{email}</strong>
          </div>
        </div>
      </header>

      {actions.length > 0 && (
        <section className="home-actions" aria-labelledby="quick-actions-title">
          <div className="home-section-heading">
            <div>
              <h2 id="quick-actions-title">{t('home.quickActions')}</h2>
              <p>{t('home.quickActionsDescription')}</p>
            </div>
          </div>
          <div className="action-card-grid">
            {actions.map(action => (
              <button
                key={action.key}
                type="button"
                className={`action-card${action.featured ? ' action-card-featured' : ''}`}
                onClick={() => navigate(action.page)}
              >
                <span className="action-card-icon"><ActionIcon name={action.icon} /></span>
                <span className="action-card-copy">
                  <strong>{action.title}</strong>
                  <span>{action.description}</span>
                </span>
                <span className="action-card-cta">{action.cta}<span aria-hidden="true" className="action-card-arrow">←</span></span>
              </button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
