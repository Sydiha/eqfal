/**
 * CompanySwitcher
 *
 * Renders a labelled <select> containing only the companies the current user
 * is allowed to access (sourced from CompanyContext). Selecting an option
 * calls setActiveCompany, which validates the choice and increments companyKey
 * to clear downstream state.
 *
 * When allowedCompanies is empty, renders a "no companies available" message
 * instead of an empty dropdown.
 */

import { useTranslation } from 'react-i18next';
import { useCompany } from '../context/CompanyContext';

export function CompanySwitcher() {
  const { t } = useTranslation();
  const { activeCompanyId, allowedCompanies, setActiveCompany } = useCompany();

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
        onChange={e => {
          if (e.target.value) setActiveCompany(e.target.value);
        }}
        style={{
          padding: '0.45rem 0.75rem',
          fontSize: '0.9rem',
          borderRadius: '6px',
          border: '1px solid #ccc',
          cursor: 'pointer',
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
