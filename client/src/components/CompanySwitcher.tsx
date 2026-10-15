/**
 * CompanySwitcher
 *
 * Renders only companies present in CompanyContext. Runtime auth integration may
 * supply onSwitch so the server validates membership before local state changes.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NativeSelect, Text } from '@mantine/core';
import { useCompany } from '../context/CompanyContext';

interface CompanySwitcherProps {
  onSwitch?: (companyId: string) => Promise<boolean>;
}

export function CompanySwitcher({ onSwitch }: CompanySwitcherProps) {
  const { t, i18n } = useTranslation();
  const { activeCompanyId, allowedCompanies, setActiveCompany } = useCompany();
  const [switching, setSwitching] = useState(false);

  // Alphabetical in the UI language.
  const options = useMemo(
    () => [...allowedCompanies]
      .sort((a, b) => a.name.localeCompare(b.name, i18n.language))
      .map(c => ({ value: c.id, label: c.name })),
    [allowedCompanies, i18n.language],
  );

  if (allowedCompanies.length === 0) {
    return (
      <Text role="status" size="sm" c="dimmed">
        {t('company.none')}
      </Text>
    );
  }

  return (
    <div className="company-switcher">
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
