import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NAVIGATION_PAGES, canShowNavigationPage, type NavigationPage } from './navigationVisibility';
import { PAGE_DESTINATIONS, canOpenDestination, destinationQuery, type DeepDestination } from '../navigation/pageDestinations';
import { Dialog } from './Dialog';
import './GlobalPageSearch.css';

type SearchResult = { id: string; page: NavigationPage; query: Record<string, string>; en: string; ar: string };

function pageLabel(page: NavigationPage, translate: (key: string, options: { lng: string }) => string): string {
  const key = page === 'sales' ? 'salesInvoices' : page === 'purchases' ? 'purchaseInvoices' : page;
  return translate(`nav.${key}`, { lng: 'en' });
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '').trim();
}

export function GlobalPageSearch({ capabilities, isSystemAdmin = false, onNavigate }: { capabilities: string[]; isSystemAdmin?: boolean; onNavigate: (page: NavigationPage, query: Record<string, string>) => void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const isArabic = i18n.language === 'ar';
  const direction = isArabic ? 'rtl' : 'ltr';
  const pages = useMemo(() => {
    const topLevel: SearchResult[] = NAVIGATION_PAGES.filter(page => canShowNavigationPage(page, capabilities)).map(page => {
      const en = pageLabel(page, (key, options) => t(key, options));
      const key = page === 'sales' ? 'salesInvoices' : page === 'purchases' ? 'purchaseInvoices' : page;
      return { id: `page:${page}`, page, query: {}, en, ar: t(`nav.${key}`, { lng: 'ar' }) };
    });
    const nested: SearchResult[] = PAGE_DESTINATIONS.filter(destination => canOpenDestination(destination, capabilities, isSystemAdmin)).map((destination: DeepDestination) => {
      const pageKey = destination.page === 'sales' ? 'salesInvoices' : destination.page === 'purchases' ? 'purchaseInvoices' : destination.page;
      const parentEn = t(`nav.${pageKey}`, { lng: 'en' });
      const parentAr = t(`nav.${pageKey}`, { lng: 'ar' });
      const crumbs = [...(destination.breadcrumbKeys ?? []), destination.labelKey];
      const en = [parentEn, ...crumbs.map(key => t(key, { lng: 'en' }))].join(' › ');
      const ar = [parentAr, ...crumbs.map(key => t(key, { lng: 'ar' }))].join(' / ');
      return { id: `destination:${destination.id}`, page: destination.page, query: destinationQuery(destination), en, ar };
    });
    return [...topLevel, ...nested];
  }, [capabilities, isSystemAdmin, t]);
  const results = useMemo(() => {
    const term = normalize(query);
    if (!term) return [];
    return pages.filter(({ en, ar }) => normalize(`${en} ${ar}`).includes(term));
  }, [pages, query]);

  const close = () => { setOpen(false); setQuery(''); setActiveIndex(0); };
  const selectPage = (result: SearchResult) => {
    if (result.id.startsWith('destination:')) {
      const destination = PAGE_DESTINATIONS.find(item => `destination:${item.id}` === result.id);
      if (!destination || !canOpenDestination(destination, capabilities, isSystemAdmin)) return;
    } else if (!canShowNavigationPage(result.page, capabilities)) return;
    onNavigate(result.page, result.query);
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
          aria-activedescendant={results.length > 0 ? `global-page-search-option-${results[activeIndex]?.id ?? results[0]?.id}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); }
            else if (event.key === 'Enter' && results.length > 0) { event.preventDefault(); selectPage(results[activeIndex] ?? results[0]!); }
          }}
        />
        {query && <button type="button" className="global-page-search__clear" aria-label={t('shell.globalSearchClear')} onClick={() => { setQuery(''); setActiveIndex(0); }}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>}
      </div>
      {results.length > 0 ? <ul id="global-page-search-results" className="global-page-search__results" role="listbox" aria-label={t('shell.globalSearchResults')} dir={direction}>
        {results.map((result, index) => <li
          id={`global-page-search-option-${result.id}`}
          key={result.id}
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? 'is-active' : undefined}
          onMouseMove={() => setActiveIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => selectPage(result)}
        >
          <span>{isArabic ? result.ar : result.en}</span>
          <span className="global-page-search__secondary" lang={isArabic ? 'en' : 'ar'}>{isArabic ? result.en : result.ar}</span>
        </li>)}
      </ul> : <p className="global-page-search__empty" role="status" aria-live="polite">{query ? t('shell.globalSearchNoResults') : t('shell.globalSearchStart')}</p>}
    </Dialog>}
  </>;
}
