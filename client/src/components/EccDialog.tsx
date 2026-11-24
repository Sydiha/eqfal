import type { ReactNode } from 'react';
import { Dialog } from './Dialog';

type Props = { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean; busy?: boolean };

/**
 * Employee Cost Center modal. Delegates to the shared accessible Dialog (portal, initial focus, Tab containment,
 * Escape, scroll lock and focus restoration); `busy` blocks Escape and backdrop dismissal while a save is in flight.
 */
export function EccDialog({ title, onClose, children, actions, wide, busy = false }: Props) {
  return <Dialog title={title} onClose={onClose} busy={busy} size={wide ? 'wide' : undefined} className="ecc-modal">
    <div className="ecc-dialog-body">{children}</div>
    {actions && <div className="modal-actions ecc-dialog-actions">{actions}</div>}
  </Dialog>;
}
