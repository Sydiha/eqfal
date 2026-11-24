import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { GrantImpact, needsExplicitConfirmation } from './accessRisk';
import { capabilityLabel, langOf } from '../labels/capabilityLabels';

export interface PendingGrant {
  impact: GrantImpact;
  /** The user (email) or role (name) receiving the authority. */
  subject: string;
  subjectKind: 'user' | 'role';
  companyName: string;
  run: () => void;
}

/**
 * Confirmation before granting sensitive authority (UX only; the server still authorizes every grant).
 * sensitive: a clear statement of impact. critical / Full Access: prominent warning plus an explicit "I understand" tick.
 */
export function GrantConfirmDialog({ pending, busy, onCancel }: { pending: PendingGrant; busy: boolean; onCancel: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const [understood, setUnderstood] = useState(false);
  const { impact } = pending;
  const explicit = needsExplicitConfirmation(impact.risk);
  const params = { subject: pending.subject, company: pending.companyName };
  return <Dialog title={t(`accessRisk.title.${impact.risk}`)} busy={busy} onClose={onCancel} className="acc-risk-dialog">
    <div className={`acc-risk acc-risk--${impact.risk}`} role={explicit ? 'alert' : 'status'}>
      <p className="acc-risk-lead">{t(pending.subjectKind === 'user' ? 'accessRisk.leadUser' : 'accessRisk.leadRole', params)}</p>
      <p>{t(`accessRisk.consequence.${impact.risk}`, params)}</p>
      {impact.flagged.length > 0 && <div className="acc-risk-groups" role="group" aria-label={t('accessRisk.newAuthority')}>
        {(['critical', 'sensitive'] as const).map((level) => {
          const items = impact.flagged.filter((item) => item.level === level);
          if (items.length === 0) return null;
          return <section key={level} className="acc-risk-group">
            <h4><span className={`acc-risk-tag acc-risk-tag--${level}`}>{t(`accessRisk.level.${level}`)}</span><span className="acc-risk-count">{items.length}</span></h4>
            <ul className="acc-risk-list">
              {items.map((item) => <li key={item.id} title={item.id}>
                <span className="acc-risk-name">{capabilityLabel(item.id, lang)}</span>
                <bdi dir="ltr"><code>{item.id}</code></bdi>
              </li>)}
            </ul>
          </section>;
        })}
      </div>}
      <p className="acc-risk-note">{t('accessRisk.serverNote')}</p>
    </div>
    {explicit && <label className="acc-risk-ack"><input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />{t('accessRisk.understand')}</label>}
    <div className="modal-actions">
      <button type="button" className="acc-ghost" onClick={onCancel}>{t('common.cancel')}</button>
      <button type="button" className={impact.risk === 'sensitive' ? 'acc-primary' : 'acc-danger'} disabled={busy || (explicit && !understood)} onClick={pending.run}>{t('accessRisk.confirm')}</button>
    </div>
  </Dialog>;
}
