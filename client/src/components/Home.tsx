import { useTranslation } from 'react-i18next';
import { useCompany } from '../context/CompanyContext';

export function Home({ email, canDocuments, canUpload, canFiscalYears, navigate }: { email: string; canDocuments: boolean; canUpload: boolean; canFiscalYears: boolean; navigate: (page: 'documents' | 'fiscalYears') => void }) {
  const { t } = useTranslation();
  const { activeCompany } = useCompany();
  return <section className="panel home-panel" aria-labelledby="home-title">
    <div className="page-heading"><div><p className="eyebrow">{t('home.workspace')}</p><h2 id="home-title">{t('home.welcome')}</h2><p>{t('home.context')}</p></div></div>
    <dl className="context-grid"><div><dt>{t('company.label')}</dt><dd>{activeCompany?.name ?? '—'}</dd></div><div><dt>{t('home.currentUser')}</dt><dd>{email}</dd></div></dl>
    {(canDocuments || canUpload || canFiscalYears) && <div className="quick-actions"><h3>{t('home.quickActions')}</h3><div>
      {canDocuments && <button onClick={() => navigate('documents')}>{t('documents.title')}</button>}
      {canUpload && <button className="primary" onClick={() => navigate('documents')}>{t('documents.upload')}</button>}
      {canFiscalYears && <button onClick={() => navigate('fiscalYears')}>{t('fiscalYears.title')}</button>}
    </div></div>}
  </section>;
}
