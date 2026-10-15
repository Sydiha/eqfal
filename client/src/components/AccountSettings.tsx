import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiErrorMessage, toApiError } from '../api/apiError';
import { useAuth } from '../context/AuthContext';
import { EqfalBrandLockup } from './EqfalBrand';

/**
 * Own-password change. The server verifies the current password, applies the password policy, ends every other session
 * and issues a fresh session for this browser, so the user stays signed in. Nothing here is stored or logged.
 */
function PasswordChangeForm({ required = false }: { required?: boolean }) {
  const { t } = useTranslation();
  const { changePassword } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const current = String(data.get('current') ?? '');
    const next = String(data.get('next') ?? '');
    setDone(false); setError(null);
    if (next !== String(data.get('confirm') ?? '')) { setError(t('auth.accountSettings.mismatch')); return; }
    setBusy(true);
    try {
      await changePassword(current, next);
      form.reset();
      setDone(true);
    } catch (reason) {
      setError(apiErrorMessage(toApiError(reason), t) ?? t('errors.NETWORK_ERROR'));
    } finally { setBusy(false); }
  };

  return <form className="login-form" onSubmit={submit} aria-labelledby="password-change-title">
    <label>{t('auth.accountSettings.current')}<input name="current" type="password" autoComplete="current-password" required maxLength={256} dir="ltr" /></label>
    <label>{t('auth.accountSettings.next')}<input name="next" type="password" autoComplete="new-password" required minLength={8} maxLength={256} dir="ltr" /></label>
    <small>{t('auth.accountSettings.hint')}</small>
    <label>{t('auth.accountSettings.confirm')}<input name="confirm" type="password" autoComplete="new-password" required minLength={8} maxLength={256} dir="ltr" /></label>
    {error && <p role="alert" className="login-error">{error}</p>}
    {done && !required && <p role="status">{t('auth.accountSettings.success')}</p>}
    <button className="primary login-submit" disabled={busy}>{busy ? t('auth.accountSettings.saving') : t('auth.accountSettings.save')}</button>
  </form>;
}

export function AccountSettings() {
  const { t } = useTranslation();
  const { session } = useAuth();
  return <section className="panel" aria-labelledby="account-title">
    <h2 id="account-title">{t('auth.accountSettings.title')}</h2>
    <p>{t('auth.accountSettings.signedInAs')} <strong dir="ltr">{session?.user.email}</strong></p>
    <h3 id="password-change-title">{t('auth.accountSettings.passwordTitle')}</h3>
    <p>{t('auth.accountSettings.passwordIntro')}</p>
    <div style={{ maxWidth: 420 }}><PasswordChangeForm /></div>
  </section>;
}

/** Shown instead of the whole application while the account carries a temporary (administratively reset) password. */
export function RequiredPasswordChange() {
  const { t, i18n } = useTranslation();
  const { logout } = useAuth();
  return <main className="login-shell">
    <div className="login-language"><button onClick={() => void i18n.changeLanguage(i18n.language === 'ar' ? 'en' : 'ar')}>{t('app.switchLanguage')}</button></div>
    <section className="login-layout" aria-labelledby="password-change-title">
      <div className="login-card">
        <div className="login-card-header">
          <div className="login-card-mobile-brand"><EqfalBrandLockup subtitle={t('app.subtitle')} /></div>
          <h2 id="password-change-title">{t('auth.accountSettings.requiredTitle')}</h2>
          <p>{t('auth.accountSettings.requiredIntro')}</p>
        </div>
        <PasswordChangeForm required />
        <button className="acc-ghost" onClick={() => void logout()}>{t('auth.accountSettings.requiredSignOut')}</button>
      </div>
    </section>
  </main>;
}
