import { useEffect, useId, type ReactNode } from 'react';

type Props = { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean };

/** Modal used by Employee Cost Center creation and operational forms. */
export function EccDialog({ title, onClose, children, actions, wide }: Props) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="ecc-dialog-backdrop"><section className={`ecc-dialog${wide ? ' ecc-dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <div className="ecc-dialog-form"><h3 id={titleId}>{title}</h3><div className="ecc-dialog-body">{children}</div>{actions && <div className="ecc-dialog-actions">{actions}</div>}</div>
  </section></div>;
}
