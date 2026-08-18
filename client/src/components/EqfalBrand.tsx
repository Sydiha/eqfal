export function EqfalBrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`eqfal-brand-mark${compact ? ' eqfal-brand-mark--compact' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 64 64" fill="none" role="img" focusable="false">
        <circle cx="25" cy="8" r="4" fill="#0E8F7A" />
        <circle cx="39" cy="8" r="4" fill="#0E8F7A" />
        <circle cx="31" cy="33" r="19" stroke="#0B1D3A" strokeWidth="7" />
        <path d="M28 25v17" stroke="#C8A66A" strokeWidth="3.5" strokeLinecap="round" />
        <path d="M35 21v24" stroke="#C8A66A" strokeWidth="3.5" strokeLinecap="round" />
        <path d="M40.5 42.5 59 57H48L35.5 47.5Z" fill="#0E8F7A" />
      </svg>
    </span>
  );
}

export function EqfalBrandLockup({ subtitle, compact = false }: { subtitle?: string; compact?: boolean }) {
  return (
    <span className={`eqfal-brand-lockup${compact ? ' eqfal-brand-lockup--compact' : ''}`}>
      <EqfalBrandMark compact={compact} />
      <span className="eqfal-brand-copy">
        <span className="eqfal-brand-wordmark"><span lang="ar">إقفال</span><span aria-hidden="true"> | </span><span lang="en">EQFAL</span></span>
        {subtitle ? <span className="eqfal-brand-subtitle">{subtitle}</span> : null}
      </span>
    </span>
  );
}
