import { useTranslation } from 'react-i18next';
import { formatDisplayDateTime } from '../date-format';
import { auditFieldLabel, auditStatusLabel, capabilityLabel } from '../labels/auditLabels';
import { langOf } from '../labels/capabilityLabels';

type Data = Record<string, unknown> | null;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Readable before/after table for an audit entry. Raw JSON stays available in a collapsed block; nothing is hidden or altered. */
export function AuditDetails({ before, after }: { before: Data; after: Data }) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];

  const render = (key: string, value: unknown): JSX.Element => {
    if (value === undefined || value === null || value === '') return <span className="acc-hint">—</span>;
    if (typeof value === 'boolean') return <>{t(value ? 'auditLog.yes' : 'auditLog.no')}</>;
    if (typeof value === 'number') return <span dir="ltr">{value}</span>;
    if (typeof value === 'string') {
      if (ISO.test(value) && !Number.isNaN(Date.parse(value))) return <span dir="ltr">{formatDisplayDateTime(value, i18n.language)}</span>;
      const status = key === 'status' || key.endsWith('_status') || key.endsWith('_type') ? auditStatusLabel(value, lang) : null;
      if (status) return <>{status}</>;
      return <span dir="auto">{value}</span>;
    }
    if (key === 'capabilities' && Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return <ul className="acc-audit-list">{(value as string[]).map((id) => <li key={id}>{capabilityLabel(id, lang)}</li>)}</ul>;
    }
    if (Array.isArray(value) && value.length === 0) return <span className="acc-hint">—</span>;
    return <code dir="ltr" className="acc-audit-inline">{JSON.stringify(value)}</code>; // nested data: shown as-is, never guessed
  };
  const same = (key: string) => JSON.stringify(before?.[key]) === JSON.stringify(after?.[key]);

  return <div className="acc-audit-details">
    {keys.length > 0 && <div className="acc-table"><table><thead><tr>
      <th>{t('auditLog.field')}</th><th>{t('auditLog.before')}</th><th>{t('auditLog.after')}</th>
    </tr></thead><tbody>{keys.map((key) => <tr key={key} className={same(key) ? '' : 'is-changed'}>
      <th scope="row" title={key}>{auditFieldLabel(key, lang)}</th>
      <td>{render(key, before?.[key])}</td>
      <td>{render(key, after?.[key])}</td>
    </tr>)}</tbody></table></div>}
    <details className="acc-audit-raw"><summary>{t('auditLog.rawData')}</summary>
      <div className="acc-roles"><div><strong>{t('auditLog.before')}</strong><pre dir="ltr">{before ? JSON.stringify(before, null, 2) : '—'}</pre></div>
      <div><strong>{t('auditLog.after')}</strong><pre dir="ltr">{after ? JSON.stringify(after, null, 2) : '—'}</pre></div></div>
    </details>
  </div>;
}
