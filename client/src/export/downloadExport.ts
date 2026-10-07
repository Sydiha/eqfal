import { buildXlsx, type ExportCell, type ExportLayout, type ExportRows, type XlsxImages } from './xlsx-builder';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ExportDocument {
  /** Deterministic ASCII file stem, e.g. eqfal-trial-balance-2026 */
  fileStem: string;
  sheetName: string;
  rtl: boolean;
  /** Metadata block, header and data rows, totals included. */
  rows: ExportRows;
  /** Which rows are metadata / headers / totals / sections (drives XLSX styling and the print table). */
  layout: ExportLayout;
}

const csvText = (cell: ExportCell) => {
  if (cell === null) return '';
  let text = typeof cell === 'object' ? cell.num : cell;
  // Neutralise spreadsheet formula injection for free text; numbers are emitted verbatim.
  if (typeof cell === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export const toCsv = (rows: ExportRows) => `﻿${rows.map((row) => row.map(csvText).join(',')).join('\r\n')}\r\n`;

/** Lower-case ASCII slug for filenames; non [a-z0-9] runs collapse to '-'. */
export const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
export const downloadXlsx = (doc: ExportDocument, images?: XlsxImages) =>
  downloadBlob(new Blob([buildXlsx(doc.sheetName, doc.rows, doc.rtl, doc.layout, doc.rtl ? 'إقفال | EQFAL' : 'EQFAL | إقفال', images) as BlobPart], { type: XLSX_MIME }), `${doc.fileStem}.xlsx`);
export const downloadCsv = (doc: ExportDocument) =>
  downloadBlob(new Blob([toCsv(doc.rows)], { type: 'text/csv;charset=utf-8' }), `${doc.fileStem}.csv`);

/** Adds the temporary @page rule for a print run (A4, orientation, margins); returns its cleanup. */
export function applyPrintPage(landscape: boolean): () => void {
  const style = document.createElement('style');
  style.textContent = `@media print{@page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:10mm}}`;
  document.head.appendChild(style);
  return () => style.remove();
}
