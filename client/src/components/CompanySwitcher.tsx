/**
 * CompanySwitcher
 *
 * Renders only companies present in CompanyContext. Runtime auth integration may
 * supply onSwitch so the server validates membership before local state changes.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NativeSelect, Text, TextInput } from '@mantine/core';
import { useCompany } from '../context/CompanyContext';

/** Search box appears only when the list is long enough to need it. */
const SEARCH_THRESHOLD = 8;

interface CompanySwitcherProps {
  onSwitch?: (companyId: string) => Promise<boolean>;
}

export function CompanySwitcher({ onSwitch }: CompanySwitcherProps) {
  const { t, i18n } = useTranslation();
  const { activeCompanyId, allowedCompanies, setActiveCompany } = useCompany();
  const [switching, setSwitching] = useState(false);
  const [query, setQuery] = useState('');

  // Alphabetical in the UI language; the active company is always kept so the select never shows a blank value.
  const options = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...allowedCompanies]
      .sort((a, b) => a.name.localeCompare(b.name, i18n.language))
      .filter(c => !needle || c.id === activeCompanyId || c.name.toLocaleLowerCase().includes(needle))
      .map(c => ({ value: c.id, label: c.name }));
  }, [allowedCompanies, query, activeCompanyId, i18n.language]);
  const showSearch = allowedCompanies.length >= SEARCH_THRESHOLD;

  if (allowedCompanies.length === 0) {
    return (
      <Text role="status" size="sm" c="dimmed">
        {t('company.none')}
      </Text>
    );
  }

  return (
    <div className="company-switcher">
      {showSearch && (
        <TextInput
          type="search"
          aria-label={t('company.search')}
          placeholder={t('company.search')}
          value={query}
          disabled={switching}
          onChange={event => setQuery(event.currentTarget.value)}
        />
      )}
      {showSearch && query.trim() !== '' && options.length <= 1 && (
        <Text role="status" size="xs" c="dimmed">{t('company.noMatch')}</Text>
      )}
      <NativeSelect
        id="company-switcher"
        label={t('company.label')}
        aria-label={t('company.switchAriaLabel')}
        value={activeCompanyId ?? ''}
        disabled={switching}
        data={options}
        onChange={event => {
          const nextId = event.currentTarget.value;
          if (!nextId || nextId === activeCompanyId) return;

          if (!onSwitch) {
            setActiveCompany(nextId);
            return;
          }

          setSwitching(true);
          void onSwitch(nextId)
            .then((accepted) => {
              if (accepted) setActiveCompany(nextId);
            })
            .finally(() => setSwitching(false));
        }}
      />
    </div>
  );
}
