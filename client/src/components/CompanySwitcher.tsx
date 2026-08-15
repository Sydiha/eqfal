/**
 * CompanySwitcher
 *
 * Renders only companies present in CompanyContext. Runtime auth integration may
 * supply onSwitch so the server validates membership before local state changes.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCompany } from '../context/CompanyContext';

interface CompanySwitcherProps {
  onSwitch?: (companyId: string) => Promise<boolean>;
}

export function CompanySwitcher({ onSwitch }: CompanySwitcherProps) {
  const { t } = useTranslation();
  const { activeCompanyId, allowedCompanies, setActiveCompany } = useCompany();
  const [switching, setSwitching] = useState(false);

  if (allowedCompanies.length === 0) {
    return (
      <p
        role="status"
        style={{ fontSize: '0.85rem', color: '#888', marginTop: '1.5rem' }}
      >
        {t('company.none')}
      </p>
    );
  }

  return (
    <div className="company-switcher">
      <label htmlFor="company-switcher">
        {t('company.label')}
      </label>
      <select
        id="company-switcher"
        aria-label={t('company.switchAriaLabel')}
        value={activeCompanyId ?? ''}
        disabled={switching}
        onChange={e => {
          const nextId = e.target.value;
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
      >
        {allowedCompanies.map(c => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
