// Dependency-free XLSX writer (stored ZIP + minimal SpreadsheetML), client-side counterpart of
// the server VAT working-paper builder. Numeric cells keep the server decimal string verbatim.
export type ExportCell = string | { num: string; int?: boolean } | null;
/** Row classification used for styling (indexes into the full rows array). */
export interface ExportLayout { metaEnd: number; headerRows: number[]; totalRows: number[]; sectionRows: number[] }
export type ExportRows = ExportCell[][];
/** PNG image (already normalised by the caller) with its pixel size, placed in the header band of the sheet. */
export interface XlsxImage { bytes: Uint8Array; width: number; height: number }
export interface XlsxImages { company?: XlsxImage | null; eqfal?: XlsxImage | null }
const EMU = 9525;
const BAND_PT = 48; // header band row height; images are scaled to fit inside it
const fit = (img: XlsxImage, maxW: number, maxH: number) => { const k = Math.min(1, maxW / img.width, maxH / img.height); return { w: Math.max(1, Math.round(img.width * k)), h: Math.max(1, Math.round(img.height * k)) }; };
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function pic(rid: string, id: number, name: string, col: number, w: number, h: number): string {
  const cx = w * EMU, cy = h * EMU;
  return `<xdr:oneCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>${3 * EMU}</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>${4 * EMU}</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="${name}" descr="${name}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
}

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

export function buildXlsx(sheetName: string, input: ExportRows, rtl: boolean, layout?: ExportLayout, brand?: string, images?: XlsxImages): Uint8Array {
  const safeName = sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report';
  // An optional brand row is prepended; every layout index shifts by one.
  const placed = [images?.company ? { key: 'company', img: images.company } : null, images?.eqfal ? { key: 'eqfal', img: images.eqfal } : null].filter((x): x is { key: string; img: XlsxImage } => !!x);
  const band = placed.length > 0 ? 1 : 0; // empty tall row that carries the logos
  const brandRow = band;
  const shift = band + (brand ? 1 : 0);
  const rows: ExportRows = [...(band ? [[]] : []), ...(brand ? [[brand]] : []), ...input];
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
      if (brand && r === brandRow) style = c === 0 ? 1 : 0;
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
    const ht = isHead ? ' ht="22" customHeight="1"' : band && r === 0 ? ` ht="${BAND_PT}" customHeight="1"` : r === brandRow && brand ? ' ht="24" customHeight="1"' : '';
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
  const files: Array<{ name: string; data: Uint8Array }> = [
    { name: '[Content_Types].xml', text: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + (band ? '<Default Extension="png" ContentType="image/png"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '') + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', text: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', text: STYLES },
    { name: 'xl/worksheets/sheet1.xml', text: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${band ? ` xmlns:r="${R_NS}"` : ''}><sheetViews><sheetView workbookViewId="0" showGridLines="0"${rtl ? ' rightToLeft="1"' : ''}>${pane}</sheetView></sheetViews>${cols}<sheetData>${sheetRows}</sheetData><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="landscape" fitToHeight="0"/>${band ? '<drawing r:id="rId1"/>' : ''}</worksheet>` },
  ].map((f) => ({ name: f.name, data: encoder.encode(f.text) }));
  if (band) {
    // Company logo (if any) sits in column A, the EQFAL mark in column B (or A when there is no company logo).
    const anchors = placed.map((p, i) => {
      const box = p.key === 'company' ? fit(p.img, 190, 56) : fit(p.img, 96, 44);
      return { ...p, rid: `rId${i + 1}`, file: `image${i + 1}.png`, col: p.key === 'company' ? 0 : placed.length - 1 === 0 ? 0 : 1, box };
    });
    const drawing = `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R_NS}">${anchors.map((a, i) => pic(a.rid, i + 2, a.key === 'company' ? 'Company logo' : 'EQFAL logo', a.col, a.box.w, a.box.h)).join('')}</xdr:wsDr>`;
    const text = (name: string, body: string) => ({ name, data: encoder.encode(body) });
    files.push(
      text('xl/worksheets/_rels/sheet1.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>'),
      text('xl/drawings/drawing1.xml', drawing),
      text('xl/drawings/_rels/drawing1.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${anchors.map((a) => `<Relationship Id="${a.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${a.file}"/>`).join('')}</Relationships>`),
      ...anchors.map((a) => ({ name: `xl/media/${a.file}`, data: a.img.bytes })),
    );
  }
  return zipStore(files);
}
