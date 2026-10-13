import { ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// Background scroll is locked while any dialog is mounted; the previous inline value is restored by the last dialog to close.
let openDialogs = 0;
let previousOverflow = '';
function lockScroll() {
  if (openDialogs++ === 0) { previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
}
function unlockScroll() {
  if (--openDialogs === 0) document.body.style.overflow = previousOverflow;
}

/**
 * Shared modal. Rendered in a portal on document.body so no ancestor stacking context can place page chrome above it.
 * The dialog is capped to the viewport and scrolls internally (see .modal in shared-ui.css), traps Tab focus,
 * locks background scrolling and restores focus to the opener on close. size="wide" is for forms and tables.
 */
export function Dialog({ title, children, busy = false, onClose, size }: { title: string; children: ReactNode; busy?: boolean; onClose: () => void; size?: 'wide' }) {
  const titleId = useRef(`dialog-${Math.random().toString(36).slice(2)}`);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    lockScroll();
    const firstControl = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (firstControl ?? dialog)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (controls.length === 0) { event.preventDefault(); dialog.focus(); return; }
      const first = controls[0]!, last = controls[controls.length - 1]!;
      const active = document.activeElement;
      if (!dialog.contains(active)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && (active === first || active === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); unlockScroll(); previous?.focus(); };
  }, []);
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId.current} className={size === 'wide' ? 'modal modal--wide' : 'modal'} tabIndex={-1}>
      <h3 id={titleId.current}>{title}</h3>{children}
    </div>
  </div>, document.body);
}
