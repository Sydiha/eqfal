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
    <div style={{ marginTop: '1.5rem', textAlign: 'start' }}>
      <label
        htmlFor="company-switcher"
        style={{
          display: 'block',
          marginBottom: '0.4rem',
          fontSize: '0.8rem',
          color: '#555',
          fontWeight: 500,
        }}
      >
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
        style={{
          padding: '0.45rem 0.75rem',
          fontSize: '0.9rem',
          borderRadius: '6px',
          border: '1px solid #ccc',
          cursor: switching ? 'wait' : 'pointer',
          minWidth: '220px',
          background: '#fff',
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
