import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NAVIGATION_PAGES, canShowNavigationPage, type NavigationPage } from './navigationVisibility';
import { Dialog } from './Dialog';
import './GlobalPageSearch.css';

type PageLabels = { en: string; ar: string };

function labelsFor(page: NavigationPage, translate: (key: string, options: { lng: string }) => string): PageLabels {
  const key = page === 'sales' ? 'salesInvoices' : page === 'purchases' ? 'purchaseInvoices' : page;
  return { en: translate(`nav.${key}`, { lng: 'en' }), ar: translate(`nav.${key}`, { lng: 'ar' }) };
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '').trim();
}

export function GlobalPageSearch({ capabilities, onNavigate }: { capabilities: string[]; onNavigate: (page: NavigationPage) => void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const isArabic = i18n.language === 'ar';
  const direction = isArabic ? 'rtl' : 'ltr';
  const pages = useMemo(() => NAVIGATION_PAGES
    .filter((page) => canShowNavigationPage(page, capabilities))
    .map((page) => ({ page, labels: labelsFor(page, t) })), [capabilities, t]);
  const results = useMemo(() => {
    const term = normalize(query);
    if (!term) return [];
    return pages.filter(({ labels }) => normalize(`${labels.en} ${labels.ar}`).includes(term));
  }, [pages, query]);

  const close = () => { setOpen(false); setQuery(''); setActiveIndex(0); };
  const selectPage = (page: NavigationPage) => {
    if (!canShowNavigationPage(page, capabilities)) return;
    onNavigate(page);
    close();
  };
  const moveActive = (step: number) => {
    if (results.length === 0) return;
    setActiveIndex((current) => (current + step + results.length) % results.length);
  };

  return <>
    <button type="button" className="topbar-icon-button" aria-label={t('shell.globalSearch')} onClick={() => { setQuery(''); setActiveIndex(0); setOpen(true); }}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
    </button>
    {open && <Dialog title={t('shell.globalSearchTitle')} onClose={close} className="global-page-search">
      <label className="global-page-search__label" htmlFor="global-page-search-input">{t('shell.globalSearchLabel')}</label>
      <div className="global-page-search__field" dir={direction}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input
          id="global-page-search-input"
          type="search"
          autoComplete="off"
          value={query}
          placeholder={t('shell.globalSearchPlaceholder')}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={results.length > 0}
          aria-controls={results.length > 0 ? 'global-page-search-results' : undefined}
          aria-activedescendant={results.length > 0 ? `global-page-search-option-${results[activeIndex]?.page ?? results[0]?.page}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); }
            else if (event.key === 'Enter' && results.length > 0) { event.preventDefault(); selectPage(results[activeIndex]?.page ?? results[0]!.page); }
          }}
        />
        {query && <button type="button" className="global-page-search__clear" aria-label={t('shell.globalSearchClear')} onClick={() => { setQuery(''); setActiveIndex(0); }}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>}
      </div>
      {results.length > 0 ? <ul id="global-page-search-results" className="global-page-search__results" role="listbox" aria-label={t('shell.globalSearchResults')} dir={direction}>
        {results.map(({ page, labels }, index) => <li
          id={`global-page-search-option-${page}`}
          key={page}
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? 'is-active' : undefined}
          onMouseMove={() => setActiveIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => selectPage(page)}
        >
          <span>{isArabic ? labels.ar : labels.en}</span>
          <span className="global-page-search__secondary" lang={isArabic ? 'en' : 'ar'}>{isArabic ? labels.en : labels.ar}</span>
        </li>)}
      </ul> : <p className="global-page-search__empty" role="status" aria-live="polite">{query ? t('shell.globalSearchNoResults') : t('shell.globalSearchStart')}</p>}
    </Dialog>}
  </>;
}
