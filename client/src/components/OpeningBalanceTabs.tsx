import { KeyboardEvent, ReactNode, useRef, useState } from 'react';
import type { Readiness, ReadinessBlocker } from './OpeningBalanceExceptions';
import { describeIssueCode } from './OpeningBalanceExceptions';

// C4-UI1: presentation-only helpers for the Opening Balances page — accessible tabs and the single approval-readiness summary.
// Nothing here decides approval: the server stays the authority and the page keeps using the existing gate callback.
export type ObTabKey = 'items' | 'recon' | 'review';

export function ObTabs({ tabs, active, onChange, rtl, label }: { tabs: Array<{ key: ObTabKey; label: string; count?: number }>; active: ObTabKey; onChange: (k: ObTabKey) => void; rtl: boolean; label: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (k: ObTabKey) => { onChange(k); refs.current[k]?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex(t => t.key === active);
    const next = rtl ? 'ArrowLeft' : 'ArrowRight', prev = rtl ? 'ArrowRight' : 'ArrowLeft';
    let n = -1;
    if (e.key === 'Home') n = 0; else if (e.key === 'End') n = tabs.length - 1;
    else if (e.key === next) n = (i + 1) % tabs.length; else if (e.key === prev) n = (i - 1 + tabs.length) % tabs.length;
    if (n >= 0) { e.preventDefault(); move(tabs[n]!.key); }
  };
  return <div className="ob-tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
    {tabs.map(t => <button key={t.key} ref={el => { refs.current[t.key] = el; }} type="button" role="tab" id={`ob-tab-${t.key}`} aria-selected={active === t.key} aria-controls={`ob-panel-${t.key}`} tabIndex={active === t.key ? 0 : -1} onClick={() => onChange(t.key)}>
      {t.label}{t.count ? <span className="ob-badge ob-badge--warn ob-tabs__count"><span className="ob-sr">{' '}</span><bdi dir="ltr">{t.count}</bdi></span> : null}
    </button>)}
  </div>;
}

// Inactive panels stay MOUNTED (the evidence section owns the approval-gate lifecycle) and are hidden: `hidden` removes them from
// the tab order and from the accessibility tree.
export function ObPanel({ tab, active, children }: { tab: ObTabKey; active: boolean; children: ReactNode }) {
  return <div role="tabpanel" id={`ob-panel-${tab}`} aria-labelledby={`ob-tab-${tab}`} hidden={!active} className="ob-panel">{children}</div>;
}

const TX = {
  en: {
    title: 'Approval readiness', ready: 'No blockers — approval is available to authorized approvers.', readyDraft: 'Nothing blocks submitting for review.',
    approved: 'The opening balance is approved.', n: (k: number) => `${k} ${k === 1 ? 'blocker prevents' : 'blockers prevent'} approval`, nSubmit: (k: number) => `${k} ${k === 1 ? 'blocker prevents' : 'blockers prevent'} submitting for review`,
    show: 'Show details', hide: 'Hide details', problem: 'Problem', item: 'Affected item', action: 'Required action', go: 'Go to fix', goItem: 'Show item',
    later: 'Also required before approval (does not block submitting):', laterNote: 'These are checked again by the server when you approve.',
    p: { noItems: 'No opening balance items', diff: 'Debit does not equal credit', fewItems: 'Fewer than two items', blocked: 'Blocked finding', mismatch: 'Evidence mismatch', none: 'Exception not accepted', stale: 'Accepted exception is stale', gate_failed: 'Evidence review could not be loaded', gate_checking: 'Evidence is being checked' },
    a: { noItems: 'Add at least one item or import a file.', diff: 'Correct amounts or sides until the difference is zero.', fewItems: 'Add at least one more item so a journal with two lines can be produced.', blocked: 'Correct the item or its link. This cannot be accepted as an exception.', mismatch: 'Correct the amount or side to match the evidence. This cannot be accepted as an exception.', none: 'Accept the exception with a reason (requires the exception permission and the In review status), or attach evidence.', stale: 'Review the new figures and accept the exception again, or revoke it.', gate_failed: 'Retry the evidence review. Approval stays unavailable until it loads (fail closed).', gate_checking: 'Wait for the check to finish. Approval stays unavailable meanwhile.' },
    dTitle: 'Difference',
  },
  ar: {
    title: 'جاهزية الاعتماد', ready: 'لا توجد موانع — الاعتماد متاح للمعتمدين المخوَّلين.', readyDraft: 'لا شيء يمنع الإرسال للمراجعة.',
    approved: 'تم اعتماد الرصيد الافتتاحي.', n: (k: number) => k === 1 ? 'مانع واحد يمنع الاعتماد' : `${k} موانع تمنع الاعتماد`, nSubmit: (k: number) => k === 1 ? 'مانع واحد يمنع الإرسال للمراجعة' : `${k} موانع تمنع الإرسال للمراجعة`,
    show: 'عرض التفاصيل', hide: 'إخفاء التفاصيل', problem: 'المشكلة', item: 'البند المتأثر', action: 'الإجراء المطلوب', go: 'اذهب للمعالجة', goItem: 'عرض البند',
    later: 'مطلوب أيضاً قبل الاعتماد (لا يمنع الإرسال):', laterNote: 'يعيد الخادم فحص هذه الشروط عند الاعتماد.',
    p: { noItems: 'لا توجد بنود أرصدة افتتاحية', diff: 'المدين لا يساوي الدائن', fewItems: 'عدد البنود أقل من اثنين', blocked: 'ملاحظة محجوبة', mismatch: 'عدم تطابق مع الدليل', none: 'استثناء غير مقبول', stale: 'استثناء مقبول أصبح قديماً', gate_failed: 'تعذر تحميل مراجعة الأدلة', gate_checking: 'جارٍ فحص الأدلة' },
    a: { noItems: 'أضف بنداً واحداً على الأقل أو استورد ملفاً.', diff: 'صحّح المبالغ أو الأطراف حتى يصبح الفرق صفراً.', fewItems: 'أضف بنداً آخر ليمكن إنتاج قيد بسطرين.', blocked: 'صحّح البند أو ربطه. لا يمكن قبولها كاستثناء.', mismatch: 'صحّح المبلغ أو الجانب ليطابق الدليل. لا يمكن قبولها كاستثناء.', none: 'اقبل الاستثناء مع سبب (يتطلب صلاحية الاستثناءات وحالة «قيد المراجعة»)، أو أرفق دليلاً.', stale: 'راجع الأرقام الجديدة ثم اقبل الاستثناء مجدداً أو اسحبه.', gate_failed: 'أعد محاولة مراجعة الأدلة. يبقى الاعتماد غير متاح حتى ينجح التحميل (فشل مغلق).', gate_checking: 'انتظر اكتمال الفحص. يبقى الاعتماد غير متاح خلال ذلك.' },
    dTitle: 'الفرق',
  },
} as const;

export type Row = { key: string; kind: keyof typeof TX.en.p; tab: ObTabKey; target?: string; itemId?: string | null; code?: string; later: boolean };

/** Builds the displayed list from page facts plus the server-derived evidence readiness. Never invents item ids. */
export function buildRows(o: { status: 'draft' | 'in_review' | 'approved'; itemCount: number; differenceIsZero: boolean; readiness: Readiness | null }): Row[] {
  const rows: Row[] = [];
  const draft = o.status === 'draft';
  if (o.itemCount === 0) rows.push({ key: 'noItems', kind: 'noItems', tab: 'items', target: 'ob-add-item', later: false });
  else if (o.itemCount < 2) rows.push({ key: 'fewItems', kind: 'fewItems', tab: 'items', target: 'ob-add-item', later: true });
  if (o.itemCount > 0 && !o.differenceIsZero) rows.push({ key: 'diff', kind: 'diff', tab: 'items', target: 'ob-summary', later: true });
  (o.readiness?.blockers ?? []).forEach((b: ReadinessBlocker) => rows.push({ key: b.key, kind: b.kind, tab: 'recon', target: b.findingId, itemId: b.item_id, code: b.code, later: draft && !(b.kind === 'blocked' || b.kind === 'mismatch') }));
  return rows;
}

export function ObReadiness({ lang, status, rows, itemLine, onGo, open, onToggle, describedBy }: { lang: 'ar' | 'en'; status: 'draft' | 'in_review' | 'approved'; rows: Row[]; itemLine: (id: string) => string; onGo: (tab: ObTabKey, target?: string, itemId?: string | null) => void; open: boolean; onToggle: () => void; describedBy?: string }) {
  const t = TX[lang];
  if (status === 'approved') return <section className="ob-card ob-ready ob-ready--ok" aria-labelledby="ob-ready-title" id={describedBy}><h2 id="ob-ready-title">{t.title}</h2><p role="status">✓ {t.approved}</p></section>;
  const draft = status === 'draft';
  const now = rows.filter(r => !r.later), later = rows.filter(r => r.later);
  const shown = draft ? now : rows;
  const ok = shown.length === 0;
  const head = ok ? (draft ? t.readyDraft : t.ready) : (draft ? t.nSubmit(shown.length) : t.n(shown.length));
  const li = (r: Row) => <li key={r.key} className="ob-ready__item">
    <strong><span aria-hidden="true">{r.kind === 'gate_checking' ? '…' : '✕'}</span> {t.p[r.kind]}{r.code ? <> — <span>{describeIssueCode(lang, r.code)}</span></> : null}</strong>
    {r.itemId ? <span className="ob-ready__line"><b>{t.item}:</b> {itemLine(r.itemId)}</span> : null}
    <span className="ob-ready__line"><b>{t.action}:</b> {t.a[r.kind]}</span>
    <span className="ob-ready__go"><button type="button" className="ob-link" onClick={() => onGo(r.tab, r.target, null)}>{t.go}</button>{r.itemId ? <button type="button" className="ob-link" onClick={() => onGo('items', undefined, r.itemId)}>{t.goItem}</button> : null}</span>
  </li>;
  return <section className={`ob-card ob-ready ${ok ? 'ob-ready--ok' : 'ob-ready--blocked'}`} aria-labelledby="ob-ready-title" id={describedBy}>
    <div className="ob-ready__head">
      <h2 id="ob-ready-title">{t.title}</h2>
      <span className={`ob-badge ob-badge--${ok ? 'ok' : 'warn'}`} role="status"><span aria-hidden="true">{ok ? '✓' : '⚠'}</span> {head}</span>
      {!ok && <button type="button" className="ob-link ob-ready__toggle" aria-expanded={open} aria-controls="ob-ready-list" onClick={onToggle}>{open ? t.hide : t.show}</button>}
    </div>
    {!ok && <ol id="ob-ready-list" className="ob-ready__list" hidden={!open}>{shown.map(li)}</ol>}
    {draft && later.length > 0 && <p className="ob-muted ob-ready__later">{t.later} {later.map(r => t.p[r.kind]).join(lang === 'ar' ? '، ' : ', ')}. {t.laterNote}</p>}
  </section>;
}

export function useBlockersOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(() => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 761px)').matches);
  return [open, () => setOpen(v => !v)];
}
