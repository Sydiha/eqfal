import { downloadCsv, downloadXlsx, printReport, type ExportDocument } from '../export/downloadExport';
import '../export/export.css';

interface Props {
  language: string;
  /** Null/undefined when there is no report data yet: all buttons stay disabled. */
  document: ExportDocument | null | undefined;
  /** Title, company and period lines shown only on the printed page. */
  printTitle: string;
  printLines: string[];
  landscape?: boolean;
}

export function ExportButtons({ language, document: doc, printTitle, printLines, landscape = false }: Props) {
  const ar = language.startsWith('ar');
  const off = !doc;
  return <>
    <div className="eqfal-print-header" aria-hidden="true"><h1>{printTitle}</h1><p>{printLines.join(' · ')}</p></div>
    <div className="eqfal-export-actions" role="group" aria-label={ar ? 'تصدير التقرير' : 'Export report'}>
      <button type="button" disabled={off} onClick={() => doc && downloadXlsx(doc)}>{ar ? 'تصدير Excel' : 'Export Excel'}</button>
      <button type="button" disabled={off} onClick={() => doc && downloadCsv(doc)}>{ar ? 'تصدير CSV' : 'Export CSV'}</button>
      <button type="button" disabled={off} onClick={() => printReport(landscape)}>{ar ? 'طباعة / PDF' : 'Print / Save PDF'}</button>
    </div>
  </>;
}
