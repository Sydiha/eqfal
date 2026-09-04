import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCompany } from '../context/CompanyContext';
import { formatDisplayDate } from '../date-format';

type HomePage =
  | 'fiscalYears'
  | 'monthlyClose'
  | 'vat'
  | 'documents'
  | 'banks'
  | 'partners'
  | 'obligations'
  | 'accounting'
  | 'sales'
  | 'purchases';

type DiscoveryPage = 'documents' | 'banks' | 'obligations' | 'vat' | 'accounting';

type Period = {
  id: string;
  fiscal_year_id: string;
  period_start: string;
  period_end: string;
  status: 'open' | 'closed';
  ready: boolean;
  blockers: {
    documents: number;
    obligations: number;
    bank_transactions: number;
    vat: number;
    ledger: number;
    total: number;
  };
};

type Props = {
  capabilities: readonly string[];
  navigate: (page: HomePage) => void;
  navigateToDiscovery: (page: DiscoveryPage, parameters: Record<string, string>) => void;
  onUnauthorized: () => void;
};

export function Home({ capabilities, navigate, navigateToDiscovery, onUnauthorized }: Props) {
  const { t, i18n } = useTranslation();
  const { activeCompany } = useCompany();
  const canViewClose = capabilities.includes('fiscal_year.view');
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(canViewClose);
  const [error, setError] = useState(false);

  const load = async () => {
    if (!canViewClose) return;
    setLoading(true);
    setError(false);
    try {
      const response = await fetch('/api/monthly-close-periods', { credentials: 'same-origin' });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { periods?: Period[] };
      setPeriods(Array.isArray(payload.periods) ? payload.periods : []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canViewClose) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canViewClose]);

  const selected = periods[0] ?? null;
  const can = (capability: string) => capabilities.includes(capability);
  const periodParameters = selected
    ? { from: selected.period_start, to: selected.period_end }
    : null;

  const exceptions = selected
    ? [
        {
          key: 'documents',
          label: t('nav.documents'),
          count: selected.blockers.documents,
          canOpen: can('document.view'),
          open: () => navigateToDiscovery('documents', periodParameters!),
        },
        {
          key: 'obligations',
          label: t('nav.obligations'),
          count: selected.blockers.obligations,
          canOpen: can('obligation.view'),
          open: () => navigateToDiscovery('obligations', { confirmation: 'unconfirmed' }),
        },
        {
          key: 'banks',
          label: t('nav.banks'),
          count: selected.blockers.bank_transactions,
          canOpen: can('bank.view'),
          open: () => navigateToDiscovery('banks', { section: 'transactions', ...periodParameters! }),
        },
        {
          key: 'vat',
          label: t('nav.vat'),
          count: selected.blockers.vat,
          canOpen: can('vat.view'),
          open: () =>
            navigateToDiscovery('vat', {
              vatFrom: selected.period_start,
              vatTo: selected.period_end,
            }),
        },
        {
          key: 'ledger',
          label: `${t('nav.accounting')} / ${t('accounting.tabs.ledger')}`,
          count: selected.blockers.ledger,
          canOpen: can('accounting.view'),
          open: () =>
            navigateToDiscovery('accounting', {
              accountingTab: 'sources',
              sourceFrom: selected.period_start,
              sourceTo: selected.period_end,
            }),
        },
      ]
    : [];

  const launchers: Array<{ key: HomePage; label: string; visible: boolean }> = [
    {
      key: 'sales',
      label: t('nav.sales'),
      visible: can('document.view') && can('obligation.view'),
    },
    {
      key: 'purchases',
      label: t('nav.purchases'),
      visible: can('document.view') && can('obligation.view'),
    },
    { key: 'documents', label: t('nav.documents'), visible: can('document.view') },
    { key: 'banks', label: t('nav.banks'), visible: can('bank.view') },
    { key: 'obligations', label: t('nav.obligations'), visible: can('obligation.view') },
    { key: 'accounting', label: t('nav.accounting'), visible: can('accounting.view') },
    { key: 'vat', label: t('nav.vat'), visible: can('vat.view') },
    { key: 'monthlyClose', label: t('nav.monthlyClose'), visible: canViewClose },
    { key: 'fiscalYears', label: t('nav.fiscalYears'), visible: canViewClose },
    { key: 'partners', label: t('nav.partners'), visible: can('partner.view') },
  ].filter((item) => item.visible);

  return (
    <section className="home-modern home-v21" aria-labelledby="home-title">
      <header className="home-hero home-v21__hero">
        <div className="home-hero-copy">
          <p className="home-eyebrow">{t('home.workspace')}</p>
          <h1 id="home-title">{t('home.welcome')}</h1>
          <p className="home-intro">{t('home.context')}</p>
        </div>
        <div className="home-v21__company" aria-label={t('company.label')}>
          <span>{t('company.label')}</span>
          <strong>{activeCompany?.name ?? '—'}</strong>
        </div>
      </header>

      {canViewClose && (
        <section className="home-status-strip" aria-label={t('monthlyClose.title')}>
          {loading ? (
            <span role="status">{t('monthlyClose.loading')}</span>
          ) : error ? (
            <>
              <span role="alert">{t('monthlyClose.error')}</span>
              <button type="button" onClick={() => void load()}>{t('common.retry')}</button>
            </>
          ) : selected ? (
            <>
              <div className="home-status-strip__period">
                <span>{t('monthlyClose.title')}</span>
                <strong>
                  {formatDisplayDate(selected.period_start, i18n.language)} — {formatDisplayDate(selected.period_end, i18n.language)}
                </strong>
              </div>
              <span className={`home-status-pill home-status-pill--${selected.status}`}>
                {t(`monthlyClose.${selected.status}`)}
              </span>
              <span className={`home-status-pill ${selected.ready ? 'is-ready' : 'is-blocked'}`}>
                {selected.ready
                  ? t('monthlyClose.ready')
                  : t('monthlyClose.blocked', { count: selected.blockers.total })}
              </span>
            </>
          ) : (
            <span role="status">{t('monthlyClose.empty')}</span>
          )}
        </section>
      )}

      {canViewClose && selected && (
        <div className="home-v21__workspace-grid">
          <section className="home-exceptions" aria-labelledby="home-exceptions-title">
            <div className="home-v21__section-heading">
              <div>
                <p className="home-eyebrow">{t('home.workspace')}</p>
                <h2 id="home-exceptions-title">{t('monthlyClose.title')}</h2>
              </div>
              <span className={`home-status-pill ${selected.ready ? 'is-ready' : 'is-blocked'}`}>
                {selected.ready
                  ? t('monthlyClose.ready')
                  : t('monthlyClose.blocked', { count: selected.blockers.total })}
              </span>
            </div>
            <div className="home-exceptions__table-wrap">
              <table className="home-exceptions__table">
                <thead>
                  <tr>
                    <th>{t('monthlyClose.title')}</th>
                    <th>{t('documents.status')}</th>
                    <th aria-label={t('accounting.action')} />
                  </tr>
                </thead>
                <tbody>
                  {exceptions.map((item) => (
                    <tr key={item.key}>
                      <td><strong>{item.label}</strong></td>
                      <td>
                        <span className={`home-exception-count ${item.count > 0 ? 'is-blocked' : 'is-clear'}`}>
                          {item.count > 0
                            ? t('monthlyClose.blocked', { count: item.count })
                            : t('monthlyClose.ready')}
                        </span>
                      </td>
                      <td>
                        {item.canOpen && (
                          <button
                            type="button"
                            className="home-exception-open"
                            aria-label={item.label}
                            onClick={item.open}
                          >
                            <span aria-hidden="true">↗</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="home-readiness" aria-labelledby="home-readiness-title">
            <p className="home-eyebrow">{t('monthlyClose.title')}</p>
            <h2 id="home-readiness-title">
              {selected.ready
                ? t('monthlyClose.ready')
                : t('monthlyClose.blocked', { count: selected.blockers.total })}
            </h2>
            <p className="home-readiness__period">
              {formatDisplayDate(selected.period_start, i18n.language)} — {formatDisplayDate(selected.period_end, i18n.language)}
            </p>
            <div className="home-readiness__summary">
              <span>{t(`monthlyClose.${selected.status}`)}</span>
              <strong>{selected.blockers.total}</strong>
            </div>
            <button type="button" className="home-readiness__open" onClick={() => navigate('monthlyClose')}>
              {t('nav.monthlyClose')}
            </button>
          </aside>
        </div>
      )}

      {launchers.length > 0 && (
        <section className="home-launcher" aria-labelledby="home-launcher-title">
          <div className="home-v21__section-heading">
            <div>
              <h2 id="home-launcher-title">{t('home.quickActions')}</h2>
              <p>{t('home.quickActionsDescription')}</p>
            </div>
          </div>
          <div className="home-launcher__grid">
            {launchers.map((item) => (
              <button key={item.key} type="button" onClick={() => navigate(item.key)}>
                <span>{item.label}</span>
                <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
