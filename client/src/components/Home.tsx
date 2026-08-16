import { useTranslation } from 'react-i18next';
import { useCompany } from '../context/CompanyContext';

interface HomeProps {
  email: string;
  canDocuments: boolean;
  canUpload: boolean;
  canFiscalYears: boolean;
  navigate: (page: 'documents' | 'fiscalYears') => void;
}

export function Home({ email, canDocuments, canUpload, canFiscalYears, navigate }: HomeProps) {
  const { t } = useTranslation();
  const { activeCompany } = useCompany();
  const hasActions = canDocuments || canUpload || canFiscalYears;

  return (
    <section className="home-page" aria-labelledby="home-title">
      <header className="home-hero">
        <p className="eyebrow">{t('home.workspace')}</p>
        <h1 id="home-title">{t('home.welcome')}</h1>
        <p>{t('home.context')}</p>
      </header>

      <dl className="context-grid" aria-label={t('home.workspace')}>
        <div className="context-card">
          <span className="context-icon" aria-hidden="true">◇</span>
          <div><dt>{t('company.label')}</dt><dd>{activeCompany?.name ?? '—'}</dd></div>
        </div>
        <div className="context-card">
          <span className="context-icon" aria-hidden="true">○</span>
          <div><dt>{t('home.currentUser')}</dt><dd>{email}</dd></div>
        </div>
      </dl>

      {hasActions && (
        <section className="quick-actions" aria-labelledby="quick-actions-title">
          <div className="quick-actions-heading">
            <p className="eyebrow">{t('home.workspace')}</p>
            <h2 id="quick-actions-title">{t('home.quickActions')}</h2>
          </div>
          <div className="action-grid">
            {canUpload && <button className="action-card action-card-primary" onClick={() => navigate('documents')}><span aria-hidden="true">＋</span><strong>{t('documents.upload')}</strong><small>{t('documents.description')}</small></button>}
            {canDocuments && <button className="action-card" onClick={() => navigate('documents')}><span aria-hidden="true">▤</span><strong>{t('documents.title')}</strong><small>{t('documents.description')}</small></button>}
            {canFiscalYears && <button className="action-card" onClick={() => navigate('fiscalYears')}><span aria-hidden="true">▣</span><strong>{t('fiscalYears.title')}</strong><small>{t('fiscalYears.description')}</small></button>}
          </div>
        </section>
      )}
    </section>
  );
}
