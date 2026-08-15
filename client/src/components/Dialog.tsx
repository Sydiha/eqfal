import { ReactNode, useEffect, useRef } from 'react';

export function Dialog({ title, children, busy = false, onClose }: { title: string; children: ReactNode; busy?: boolean; onClose: () => void }) {
  const titleId = useRef(`dialog-${Math.random().toString(36).slice(2)}`);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const firstControl = dialog?.querySelector<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
    (firstControl ?? dialog)?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busyRef.current) onCloseRef.current(); };
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('keydown', escape); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId.current} className="modal" tabIndex={-1}>
      <h3 id={titleId.current}>{title}</h3>{children}
    </div>
  </div>;
}
