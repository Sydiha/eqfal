import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { applyPrintPage, downloadCsv, downloadXlsx, type ExportDocument } from '../export/downloadExport';
import type { ExportCell } from '../export/xlsx-builder';
import '../export/export.css';

interface Props {
  language: string;
  /** Null/undefined when there is no report data yet: all buttons stay disabled. */
  document: ExportDocument | null | undefined;
  landscape?: boolean;
}

const money = (v: string) => { const x = Number(v); return Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v; };
const show = (c: ExportCell) => (c === null ? '' : typeof c === 'object' ? (c.int ? c.num : money(c.num)) : c);

/** Print-only report: a compact table generated from the same rows as the exports. Hidden on screen. */
function PrintDocument({ doc, ar }: { doc: ExportDocument; ar: boolean }) {
  const { rows, layout } = doc;
  const bodyStart = layout.metaEnd + 1;
  const meta = rows.slice(1, layout.metaEnd);
  const body = rows.slice(bodyStart);
  const cols = Math.max(1, ...body.map((r) => r.length));
  const first = layout.headerRows[0] ?? bodyStart;
  const numeric = Array.from({ length: cols }, (_, c) => body.some((r) => typeof r[c] === 'object' && r[c] !== null));
  const kind = (abs: number) => (layout.totalRows.includes(abs) ? 't' : layout.sectionRows.includes(abs) ? 's' : layout.headerRows.includes(abs) ? 'h' : '');
  return <div className="eqfal-print-doc" dir={ar ? 'rtl' : 'ltr'} lang={ar ? 'ar' : 'en'} aria-hidden="true">
    <div className="eqfal-print-brand">{ar ? 'إقفال | EQFAL' : 'EQFAL | إقفال'}</div>
    <h1>{String(rows[0]?.[0] ?? '')}</h1>
    <dl className="eqfal-print-meta">{meta.map((r, i) => <div key={i}><dt>{show(r[0] ?? null)}</dt><dd>{show(r[1] ?? null)}</dd></div>)}</dl>
    <table>
      <thead>{rows[first] && <tr>{Array.from({ length: cols }, (_, c) => <th key={c} className={numeric[c] ? 'n' : ''}>{show(rows[first]![c] ?? null)}</th>)}</tr>}</thead>
      <tbody>{body.map((r, i) => {
        const abs = bodyStart + i;
        if (abs === first) return null;
        if (r.length === 0) return <tr key={i} className="gap"><td colSpan={cols} /></tr>;
        const k = kind(abs);
        if (r.length === 1) return <tr key={i} className={k || 'note'}><td colSpan={cols}>{show(r[0] ?? null)}</td></tr>;
        return <tr key={i} className={k}>{Array.from({ length: cols }, (_, c) => { const cell = r[c] ?? null; return <td key={c} className={typeof cell === 'object' && cell ? 'n' : ''}>{show(cell)}</td>; })}</tr>;
      })}</tbody>
    </table>
  </div>;
}

export function ExportButtons({ language, document: doc, landscape = false }: Props) {
  const ar = language.startsWith('ar');
  const off = !doc;
  // The print document only exists in the DOM while a print run is in progress.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const cleanupPage = applyPrintPage(landscape);
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    return () => { window.removeEventListener('afterprint', done); cleanupPage(); };
  }, [printing, landscape]);
  useEffect(() => { if (!doc) setPrinting(false); }, [doc]);
  return <>
    {doc && printing && createPortal(<PrintDocument doc={doc} ar={ar} />, document.body)}
    <div className="eqfal-export-actions" role="group" aria-label={ar ? 'تصدير التقرير' : 'Export report'}>
      <button type="button" disabled={off} onClick={() => doc && downloadXlsx(doc)}>{ar ? 'تصدير Excel' : 'Export Excel'}</button>
      <button type="button" disabled={off} onClick={() => doc && downloadCsv(doc)}>{ar ? 'تصدير CSV' : 'Export CSV'}</button>
      <button type="button" disabled={off} onClick={() => setPrinting(true)}>{ar ? 'طباعة / PDF' : 'Print / Save PDF'}</button>
    </div>
  </>;
}
