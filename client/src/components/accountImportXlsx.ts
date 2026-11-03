export const ACCOUNT_IMPORT_KEYS = [
  'code', 'name_ar', 'name_en', 'account_type', 'parent_code',
  'statement_category', 'is_contra', 'cash_role', 'cash_flow_category',
] as const;

export type ImportSheetRow = {
  code: string;
  name_ar: string;
  name_en: string;
  account_type: string;
  parent_code: string;
  statement_category: string;
  is_contra: string;
  cash_role: string;
  cash_flow_category: string;
};
export type AccountImportRequestRow = Omit<ImportSheetRow, 'is_contra'> & { is_contra: boolean };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const blobPart = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(bytes.length);
  new Uint8Array(copy).set(bytes);
  return copy;
};
const columnName = (number: number) => {
  let value = '';
  while (number) {
    const remainder = (number - 1) % 26;
    value = String.fromCharCode(65 + remainder) + value;
    number = Math.floor((number - 1) / 26);
  }
  return value;
};

function crc32(bytes: Uint8Array) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function zipStored(files: Array<[string, string]>) {
  const localEntries: Uint8Array[] = [];
  const centralEntries: Uint8Array[] = [];
  let localOffset = 0;
  for (const [path, content] of files) {
    const name = encoder.encode(path);
    const data = encoder.encode(content);
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    localEntries.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralEntries.push(central);
    localOffset += local.length;
  }
  const centralSize = centralEntries.reduce((size, entry) => size + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  return new Blob([...localEntries, ...centralEntries, end].map(blobPart), {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

const contentTypes = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
const packageRelationships = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
const workbookXml = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Accounts" sheetId="1" r:id="rId1"/></sheets></workbook>';
const workbookRelationships = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';

export function accountImportTemplate() {
  const arabicHeaders = ['رمز الحساب', 'الاسم بالعربية', 'الاسم بالإنجليزية', 'نوع الحساب', 'رمز الحساب الأب', 'تصنيف القوائم المالية', 'حساب مقابل؟', 'دور النقد', 'تصنيف التدفق النقدي'];
  const rows = [
    arabicHeaders,
    [...ACCOUNT_IMPORT_KEYS],
    ['SAMPLE-ASSET-001', 'مثال: الصندوق', 'Example: Cash', 'asset', '', 'current_asset', 'false', 'cash', 'operating'],
    ['SAMPLE-REVENUE-001', 'مثال: إيرادات المبيعات', 'Example: Sales revenue', 'revenue', '', 'revenue', 'false', 'non_cash', 'operating'],
  ];
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => columnIndex === 6 && rowIndex > 1 ? `<c r="${columnName(columnIndex + 1)}${rowIndex + 1}" t="b"><v>${value === 'true' ? '1' : '0'}</v></c>` : `<c r="${columnName(columnIndex + 1)}${rowIndex + 1}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  return zipStored([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', packageRelationships],
    ['xl/workbook.xml', workbookXml],
    ['xl/_rels/workbook.xml.rels', workbookRelationships],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

function u16(view: DataView, offset: number) { return view.getUint16(offset, true); }
function u32(view: DataView, offset: number) { return view.getUint32(offset, true); }
function within(bytes: Uint8Array, offset: number, length: number) { return offset >= 0 && length >= 0 && offset + length <= bytes.length; }

async function unzipXlsx(file: File) {
  if (file.size < 22 || file.size > 10 * 1024 * 1024) throw Error('bad_xlsx');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (u32(view, offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0 || !within(bytes, endOffset, 22)) throw Error('bad_xlsx');
  const diskNumber = u16(view, endOffset + 4);
  const centralDisk = u16(view, endOffset + 6);
  const diskEntries = u16(view, endOffset + 8);
  const entryCount = u16(view, endOffset + 10);
  const centralSize = u32(view, endOffset + 12);
  const centralOffset = u32(view, endOffset + 16);
  const commentLength = u16(view, endOffset + 20);
  if (diskNumber || centralDisk || diskEntries !== entryCount || entryCount > 128 || !within(bytes, endOffset + 22, commentLength) || !within(bytes, centralOffset, centralSize)) throw Error('bad_xlsx');

  const files = new Map<string, string>();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index++) {
    if (!within(bytes, cursor, 46) || u32(view, cursor) !== 0x02014b50) throw Error('bad_xlsx');
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const checksum = u32(view, cursor + 16);
    const compressedSize = u32(view, cursor + 20);
    const uncompressedSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentSize = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    const recordSize = 46 + nameLength + extraLength + commentSize;
    if (!within(bytes, cursor, recordSize) || (flags & 1) !== 0 || (method !== 0 && method !== 8) || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw Error('bad_xlsx');
    const path = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (!path || path.startsWith('/') || path.split('/').includes('..') || files.has(path)) throw Error('bad_xlsx');
    if (uncompressedSize > 10 * 1024 * 1024 || (totalUncompressed += uncompressedSize) > 20 * 1024 * 1024) throw Error('bad_xlsx');
    if (!within(bytes, localOffset, 30) || u32(view, localOffset) !== 0x04034b50) throw Error('bad_xlsx');
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (!within(bytes, dataOffset, compressedSize)) throw Error('bad_xlsx');
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    let data = compressed;
    if (method === 8) {
      const stream = new DecompressionStream('deflate-raw' as CompressionFormat);
      data = new Uint8Array(await new Response(new Blob([blobPart(compressed)]).stream().pipeThrough(stream)).arrayBuffer());
    }
    if (data.length !== uncompressedSize || crc32(data) !== checksum) throw Error('bad_xlsx');
    files.set(path, decoder.decode(data));
    cursor += recordSize;
  }
  if (cursor !== centralOffset + centralSize) throw Error('bad_xlsx');
  return files;
}

function parseXml(source: string) {
  const document = new DOMParser().parseFromString(source, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw Error('bad_xlsx');
  return document;
}

function normalizeWorksheetPath(target: string) {
  const stack: string[] = [];
  for (const segment of target.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!stack.length) throw Error('bad_xlsx');
      stack.pop();
    } else stack.push(segment);
  }
  const path = target.startsWith('/') ? stack.join('/') : ['xl', ...stack].join('/');
  if (!path.startsWith('xl/worksheets/')) throw Error('bad_xlsx');
  return path;
}

export function serializeAccountImportRows(rows: ImportSheetRow[]): AccountImportRequestRow[] {
  return rows.map((row) => {
    const contra = row.is_contra.trim().toLowerCase();
    if (contra && !['true', 'false', '1', '0'].includes(contra)) throw Error('invalid_contra');
    return { ...row, is_contra: contra === 'true' || contra === '1' };
  });
}

export async function readAccountImport(file: File): Promise<ImportSheetRow[]> {
  if (!file.name.toLowerCase().endsWith('.xlsx')) throw Error('xlsx_required');
  const files = await unzipXlsx(file);
  const workbookXml = files.get('xl/workbook.xml');
  const relationshipsXml = files.get('xl/_rels/workbook.xml.rels');
  if (!workbookXml || !relationshipsXml) throw Error('bad_xlsx');
  const workbook = parseXml(workbookXml);
  const relationships = parseXml(relationshipsXml);
  const sheet = workbook.getElementsByTagName('sheet')[0];
  const relationshipId = sheet?.getAttribute('r:id');
  if (!relationshipId) throw Error('bad_xlsx');
  const relation = Array.from(relationships.getElementsByTagName('Relationship')).find((item) => item.getAttribute('Id') === relationshipId);
  const worksheetType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
  const target = relation?.getAttribute('Target');
  if (!relation || relation.getAttribute('Type') !== worksheetType || relation.getAttribute('TargetMode') === 'External' || !target) throw Error('bad_xlsx');
  const worksheetXml = files.get(normalizeWorksheetPath(target));
  if (!worksheetXml) throw Error('bad_xlsx');

  const sharedStringsXml = files.get('xl/sharedStrings.xml');
  const sharedStrings = sharedStringsXml
    ? Array.from(parseXml(sharedStringsXml).getElementsByTagName('si')).map((item) => Array.from(item.getElementsByTagName('t')).map((text) => text.textContent ?? '').join(''))
    : [];
  const worksheet = parseXml(worksheetXml);
  const rows = Array.from(worksheet.getElementsByTagName('row'));
  const readCells = (row: Element) => {
    const values: string[] = [];
    const seenColumns = new Set<number>();
    for (const cell of Array.from(row.getElementsByTagName('c'))) {
      if (cell.getElementsByTagName('f').length) throw Error('formula_not_supported');
      const letters = (cell.getAttribute('r') ?? '').match(/^[A-Z]+/i)?.[0]?.toUpperCase();
      if (!letters) throw Error('bad_xlsx');
      let column = 0;
      for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
      if (!column || seenColumns.has(column)) throw Error('bad_xlsx');
      seenColumns.add(column);
      const raw = cell.getElementsByTagName('v')[0]?.textContent ?? cell.getElementsByTagName('t')[0]?.textContent ?? '';
      const type = cell.getAttribute('t');
      if (type === 's') {
        const shared = sharedStrings[Number(raw)];
        if (shared === undefined) throw Error('bad_xlsx');
        values[column - 1] = shared;
      } else if (type === 'b') {
        if (raw !== '0' && raw !== '1') throw Error('bad_xlsx');
        values[column - 1] = raw === '1' ? 'true' : 'false';
      } else values[column - 1] = raw;
    }
    return values;
  };

  if (rows.length < 2) throw Error('missing_headers');
  const headerKeys = readCells(rows[1]!).map((value) => value.trim());
  if (new Set(headerKeys).size !== headerKeys.length || ACCOUNT_IMPORT_KEYS.some((key) => !headerKeys.includes(key))) throw Error('bad_headers');
  const result: ImportSheetRow[] = [];
  for (const row of rows.slice(2)) {
    const values = readCells(row);
    const parsed = Object.fromEntries(ACCOUNT_IMPORT_KEYS.map((key) => [key, String(values[headerKeys.indexOf(key)] ?? '').trim()])) as ImportSheetRow;
    if (Object.values(parsed).some(Boolean)) result.push(parsed);
  }
  if (!result.length) throw Error('empty_sheet');
  return result;
}
