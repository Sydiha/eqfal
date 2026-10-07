// Dependency-free XLSX writer (stored ZIP + minimal SpreadsheetML), client-side counterpart of
// the server VAT working-paper builder. Numeric cells keep the server decimal string verbatim.
export type ExportCell = string | { num: string; int?: boolean } | null;
/** Row classification used for styling (indexes into the full rows array). */
export interface ExportLayout { metaEnd: number; headerRows: number[]; totalRows: number[]; sectionRows: number[] }
export type ExportRows = ExportCell[][];

const encoder = new TextEncoder();
const xml = (v: string) => v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (index: number) => { let n = index + 1, s = ''; while (n) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = []; const centrals: Uint8Array[] = []; let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name); const crc = crc32(file.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint32(14, crc, true);
    local.setUint32(18, file.data.length, true); local.setUint32(22, file.data.length, true); local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, file.data);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint32(16, crc, true);
    central.setUint32(20, file.data.length, true); central.setUint32(24, file.data.length, true); central.setUint16(28, name.length, true); central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + file.data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0)); let pos = 0;
  for (const b of all) { out.set(b, pos); pos += b.length; }
  return out;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="6"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FF0B5C5A"/><name val="Calibri"/></font><font><b/><sz val="13"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF595959"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B5C5A"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F3F5"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3EFEE"/></patternFill></fill></fills><borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFDBE3EA"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF0B5C5A"/></top><bottom style="double"><color rgb="FF0B5C5A"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="11"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="4" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="0" fontId="5" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="5" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="4" fontId="5" fillId="4" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="3" fontId="5" fillId="4" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/></cellXfs></styleSheet>`;

export function buildXlsx(sheetName: string, input: ExportRows, rtl: boolean, layout?: ExportLayout, brand?: string): Uint8Array {
  const safeName = sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report';
  // An optional brand row is prepended; every layout index shifts by one.
  const shift = brand ? 1 : 0;
  const rows: ExportRows = brand ? [[brand], ...input] : input;
  const set = (list: number[] | undefined) => new Set((list ?? []).map((i) => i + shift));
  const headers = set(layout?.headerRows), totals = set(layout?.totalRows), sections = set(layout?.sectionRows);
  const metaEnd = layout ? layout.metaEnd + shift : -1;
  const ncols = Math.max(1, ...rows.map((r) => r.length));
  const sheetRows = rows.map((row, r) => {
    const bodyRow = r > metaEnd;
    const isHead = headers.has(r), isTotal = totals.has(r), isSection = sections.has(r);
    const cells = Array.from({ length: bodyRow && (isHead || isTotal || isSection) ? Math.max(ncols, row.length) : row.length }, (_, c) => {
      const cell = row[c] ?? null;
      const ref = `${colName(c)}${r + 1}`;
      let style = 0;
      if (brand && r === 0) style = c === 0 ? 1 : 0;
      else if (layout && r === shift) style = c === 0 ? 2 : 0;
      else if (layout && r < metaEnd) style = c === 0 ? 3 : 0;
      else if (isHead) style = 4;
      else if (isTotal) style = typeof cell === 'object' && cell ? (cell.int ? 10 : 9) : 8;
      else if (isSection) style = 7;
      else if (typeof cell === 'object' && cell) style = cell.int ? 6 : 5;
      const s = style ? ` s="${style}"` : '';
      if (cell === null || cell === '') return style ? `<c r="${ref}"${s}/>` : '';
      if (typeof cell === 'object') return `<c r="${ref}"${s}><v>${xml(cell.num)}</v></c>`;
      return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`;
    }).join('');
    const ht = isHead ? ' ht="22" customHeight="1"' : r === 0 && brand ? ' ht="24" customHeight="1"' : '';
    return `<row r="${r + 1}"${ht}>${cells}</row>`;
  }).join('');
  const widthOf = (c: number) => {
    let w = c === 0 ? 28 : 14;
    rows.forEach((row, r) => { if (r <= metaEnd) return; const cell = row[c]; if (cell == null) return; const len = typeof cell === 'object' ? cell.num.length + 4 : cell.length; if (!sections.has(r)) w = Math.max(w, len + 2); });
    return Math.min(w, 50);
  };
  const cols = `<cols>${Array.from({ length: ncols }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${widthOf(i)}" customWidth="1"/>`).join('')}</cols>`;
  const firstHead = Math.min(...headers);
  const pane = Number.isFinite(firstHead) ? `<pane ySplit="${firstHead + 1}" topLeftCell="A${firstHead + 2}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${firstHead + 2}" sqref="A${firstHead + 2}"/>` : '';
  const files = [
    { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', text: STYLES },
    { name: 'xl/worksheets/sheet1.xml', text: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="0"${rtl ? ' rightToLeft="1"' : ''}>${pane}</sheetView></sheetViews>${cols}<sheetData>${sheetRows}</sheetData><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToHeight="0"/></worksheet>` },
  ].map((f) => ({ name: f.name, data: encoder.encode(f.text) }));
  return zipStore(files);
}
