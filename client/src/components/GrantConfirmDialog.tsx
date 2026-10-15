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
  return <Dialog title={t(`accessRisk.title.${impact.risk}`)} busy={busy} onClose={onCancel}>
    <div className={`acc-risk acc-risk--${impact.risk}`} role={explicit ? 'alert' : 'status'}>
      <p className="acc-risk-lead">{t(pending.subjectKind === 'user' ? 'accessRisk.leadUser' : 'accessRisk.leadRole', params)}</p>
      <p>{t(`accessRisk.consequence.${impact.risk}`, params)}</p>
      {impact.flagged.length > 0 && <ul className="acc-risk-list" aria-label={t('accessRisk.newAuthority')}>
        {impact.flagged.map((item) => <li key={item.id} title={item.id}>
          <span className={`acc-risk-tag acc-risk-tag--${item.level}`}>{t(`accessRisk.level.${item.level}`)}</span>{capabilityLabel(item.id, lang)}
        </li>)}
      </ul>}
      <p className="acc-risk-note">{t('accessRisk.serverNote')}</p>
    </div>
    {explicit && <label className="acc-risk-ack"><input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />{t('accessRisk.understand')}</label>}
    <div className="modal-actions">
      <button type="button" className="acc-ghost" onClick={onCancel}>{t('common.cancel')}</button>
      <button type="button" className={impact.risk === 'sensitive' ? 'acc-primary' : 'acc-danger'} disabled={busy || (explicit && !understood)} onClick={pending.run}>{t('accessRisk.confirm')}</button>
    </div>
  </Dialog>;
}
