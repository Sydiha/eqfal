import crypto from 'crypto';
import express, { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import path from 'path';
import { inflateRawSync } from 'zlib';
import { Pool, PoolClient } from 'pg';
import pool from '../../db/pool';
import config from '../../config';
import { LocalStorageAdapter } from '../../storage/local.storage';
import { StorageAdapter } from '../../storage/storage.adapter';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { AuthSessionContext } from '../auth/session.service';
import { isSafeXlsxArchive } from './xlsx-security';

export const bankRouter = Router();

const VIEW = 'bank.view';
const IMPORT = 'bank.import';
const MANAGE = 'bank.account.manage';
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_PREVIEW_ROWS = 50;
const CSV_MIME = 'text/csv';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const storage = new LocalStorageAdapter(config.bankStorageDir);
const rawParser = express.raw({ type: () => true, limit: MAX_FILE_SIZE });

type ActiveAuthContext = AuthSessionContext & { activeCompanyId: string };
type SourceFormat = 'csv' | 'xlsx';
type AmountMode = 'signed' | 'debit_credit';
type DateFormat = 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'DD-MM-YYYY';
type Cell = string | number | null;
type PhysicalRow = { sourceRowNumber: number; cells: Cell[] };
type ParsedTable = { headers: string[]; rows: Cell[][]; sourceRowNumbers: number[]; formulaCells: Set<string> };
type ColumnRef = { index: number; label?: string };
type HeaderProfile = { dateIndex: number; amountIndex: number | null; debitIndex: number | null; creditIndex: number | null; score: number };
type DetectedTable = ParsedTable & { detectionScore: number };

export type BankColumnMapping = {
  amount_mode: AmountMode;
  date_format: DateFormat;
  transaction_date: ColumnRef;
  amount?: ColumnRef;
  debit?: ColumnRef;
  credit?: ColumnRef;
  value_date?: ColumnRef;
  description?: ColumnRef;
  bank_reference?: ColumnRef;
  running_balance?: ColumnRef;
};

type BankAccount = {
  id: string; company_id: string; display_name: string; bank_name: string | null;
  currency_code: string; is_active: boolean; created_by: string; created_at: Date; updated_at: Date;
};

type BankBatch = {
  id: string; company_id: string; bank_account_id: string; original_filename: string; mime_type: string;
  source_format: SourceFormat; storage_key: string; file_sha256: string; status: 'mapping_required' | 'preview_ready' | 'confirmed';
  column_mapping: BankColumnMapping | null; total_rows: number; valid_rows: number; duplicate_rows: number; invalid_rows: number;
  created_by: string; created_at: Date; confirmed_by: string | null; confirmed_at: Date | null;
};

type NormalizedTransaction = {
  source_row_number: number;
  transaction_date: string;
  value_date: string | null;
  amount: string;
  description: string | null;
  bank_reference: string | null;
  running_balance: string | null;
  fingerprint: string;
  fingerprint_strength: 'strong' | 'weak';
  status: 'valid' | 'duplicate' | 'possible_duplicate' | 'invalid';
  error: string | null;
};

type PreviewResult = {
  totalRows: number;
  validRows: number;
  duplicateRows: number;
  possibleDuplicateRows: number;
  invalidRows: number;
  rows: NormalizedTransaction[];
};

export class BankNotFoundError extends Error {}
export class BankConflictError extends Error {}
export class BankValidationError extends Error {}
export class DuplicateBankImportError extends Error { constructor(public readonly batch: BankBatch) { super('Duplicate bank import'); } }

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => void handler(req, res, next).catch(next);
}

const parseUploadBody: RequestHandler = (req, res, next) => {
  rawParser(req, res, (err) => {
    if (!err) return next();
    if ((err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'Bank import is too large' });
      return;
    }
    next(err);
  });
};

function activeContext(req: Request, res: Response): ActiveAuthContext | null {
  const context = getAuthenticatedContext(req);
  if (!context?.activeCompanyId) {
    res.status(403).json({ error: 'No active company' });
    return null;
  }
  return context as ActiveAuthContext;
}

function serviceOr503(res: Response): BankService | null {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable' });
    return null;
  }
  return new BankService(pool, storage);
}

function decodeFilename(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    if (!decoded || decoded.length > 255 || decoded.includes('\0')) return null;
    return decoded;
  } catch { return null; }
}

function uploadFormat(filename: string, mime: string, data: Buffer): SourceFormat | null {
  if (!data.length || data.length > MAX_FILE_SIZE) return null;
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv' && mime === CSV_MIME) return 'csv';
  if (ext === '.xlsx' && mime === XLSX_MIME && data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && isSafeXlsxArchive(data)) return 'xlsx';
  return null;
}

function parseAccountBody(body: unknown): { displayName: string; bankName: string | null; currencyCode: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((k) => !['display_name', 'bank_name', 'currency_code'].includes(k))) return null;
  const displayName = typeof value.display_name === 'string' ? value.display_name.trim() : '';
  const bankName = value.bank_name == null ? null : typeof value.bank_name === 'string' ? value.bank_name.trim() : '';
  const currencyCode = typeof value.currency_code === 'string' ? value.currency_code.trim().toUpperCase() : '';
  if (!displayName || displayName.length > 120 || bankName === '' || (bankName && bankName.length > 120) || !/^[A-Z]{3}$/.test(currencyCode)) return null;
  return { displayName, bankName, currencyCode };
}

function parseMapping(body: unknown): BankColumnMapping | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const x = body as Record<string, unknown>;
  const allowed = new Set(['amount_mode','date_format','transaction_date','amount','debit','credit','value_date','description','bank_reference','running_balance']);
  if (Object.keys(x).some((k) => !allowed.has(k))) return null;
  if (x.amount_mode !== 'signed' && x.amount_mode !== 'debit_credit') return null;
  if (!['YYYY-MM-DD','DD/MM/YYYY','DD-MM-YYYY'].includes(String(x.date_format))) return null;
  const ref = (v: unknown): ColumnRef | null => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const r = v as Record<string, unknown>;
    if (!Number.isInteger(r.index) || Number(r.index) < 0 || Number(r.index) > 500) return null;
    if (r.label !== undefined && (typeof r.label !== 'string' || r.label.length > 200)) return null;
    return { index: Number(r.index), ...(typeof r.label === 'string' ? { label: r.label } : {}) };
  };
  const transactionDate = ref(x.transaction_date);
  if (!transactionDate) return null;
  const result: BankColumnMapping = { amount_mode: x.amount_mode as AmountMode, date_format: x.date_format as DateFormat, transaction_date: transactionDate };
  for (const field of ['amount','debit','credit','value_date','description','bank_reference','running_balance'] as const) {
    if (x[field] !== undefined) {
      const parsed = ref(x[field]); if (!parsed) return null; result[field] = parsed;
    }
  }
  if (result.amount_mode === 'signed' && (!result.amount || result.debit || result.credit)) return null;
  if (result.amount_mode === 'debit_credit' && (!result.debit || !result.credit || result.amount)) return null;
  const required = result.amount_mode === 'signed' ? [result.transaction_date.index, result.amount!.index] : [result.transaction_date.index, result.debit!.index, result.credit!.index];
  if (new Set(required).size !== required.length) return null;
  return result;
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (quoted) throw new BankValidationError('Invalid CSV quoting');
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

function decodeCsv(data: Buffer): string {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString('utf16le');
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) throw new BankValidationError('UTF-16BE CSV is not supported');
  const offset = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  const text = data.subarray(offset).toString('utf8');
  if (text.includes('\uFFFD')) throw new BankValidationError('Invalid CSV encoding');
  return text;
}

function readZipEntries(data: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new BankValidationError('Invalid XLSX archive');
  const count = data.readUInt16LE(eocd + 10);
  const centralOffset = data.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  for (let n = 0; n < count; n++) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) throw new BankValidationError('Invalid XLSX directory');
    const method = data.readUInt16LE(cursor + 10);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const fileNameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8');
    if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new BankValidationError('Invalid XLSX entry');
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = data.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(payload));
    else if (method === 8) entries.set(name, inflateRawSync(payload));
    else throw new BankValidationError('Unsupported XLSX compression');
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) return 0;
  let value = 0; for (const ch of letters) value = value * 26 + ch.charCodeAt(0) - 64;
  return value - 1;
}

function xmlTag(body: string, tag: string): string | null {
  const match = body.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]!.replace(/<[^>]+>/g, '')) : null;
}

function canonicalHeader(value: Cell): string {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function headerKind(value: Cell): 'date' | 'amount' | 'debit' | 'credit' | 'balance' | 'description' | 'reference' | null {
  const text = canonicalHeader(value);
  if (!text) return null;
  const has = (terms: string[]) => terms.some((term) => text === term || text.includes(term));
  if (has(['transaction date','posting date','value date','date','التاريخ','تاريخ'])) return 'date';
  if (has(['debit','withdrawal','مدين','خصم','المخصوم'])) return 'debit';
  if (has(['credit','deposit','دائن','إيداع','ايداع'])) return 'credit';
  if (has(['transaction amount','amount','المبلغ','مبلغ'])) return 'amount';
  if (has(['balance','الرصيد'])) return 'balance';
  if (has(['description','details','narration','memo','تفاصيل','الوصف','البيان','بيان'])) return 'description';
  if (has(['reference','transaction id','transaction no','ref','المرجع','رقم العملية','رقم المرجع'])) return 'reference';
  return null;
}

function profileHeader(row: Cell[]): HeaderProfile | null {
  let dateIndex: number | null = null;
  let amountIndex: number | null = null;
  let debitIndex: number | null = null;
  let creditIndex: number | null = null;
  let score = 0;
  const seen = new Set<string>();
  for (let i = 0; i < row.length; i++) {
    const kind = headerKind(row[i] ?? null);
    if (!kind) continue;
    if (!seen.has(kind)) { score++; seen.add(kind); }
    if (kind === 'date' && dateIndex === null) dateIndex = i;
    else if (kind === 'amount' && amountIndex === null) amountIndex = i;
    else if (kind === 'debit' && debitIndex === null) debitIndex = i;
    else if (kind === 'credit' && creditIndex === null) creditIndex = i;
  }
  if (dateIndex === null) return null;
  if (amountIndex === null && (debitIndex === null || creditIndex === null)) return null;
  return { dateIndex, amountIndex, debitIndex, creditIndex, score };
}

function looksLikeDateCell(value: Cell): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 1 && value <= 2_958_465;
  const text = String(value ?? '').trim();
  if (!text) return false;
  return /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(text) || /^\d{1,2}[-\/]\d{1,2}[-\/]\d{4}$/.test(text);
}

function numericValue(value: Cell): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  let text = String(value).trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  text = text.replace(/[\s,٬]/g, '').replace(/٫/g, '.');
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return negative ? -Math.abs(number) : number;
}

function looksLikeTransaction(row: Cell[], profile: HeaderProfile): boolean {
  if (!looksLikeDateCell(row[profile.dateIndex] ?? null)) return false;
  if (profile.amountIndex !== null) {
    const amount = numericValue(row[profile.amountIndex] ?? null);
    return amount !== null && amount !== 0;
  }
  const debit = numericValue(row[profile.debitIndex!] ?? null);
  const credit = numericValue(row[profile.creditIndex!] ?? null);
  const debitNonZero = debit !== null && debit !== 0;
  const creditNonZero = credit !== null && credit !== 0;
  return debitNonZero !== creditNonZero;
}

function rowIsBlank(row: Cell[]): boolean {
  return !row.some((value) => value !== null && value !== undefined && String(value).trim() !== '');
}

function looksLikeFooter(row: Cell[]): boolean {
  const text = row.map((value) => canonicalHeader(value)).filter(Boolean).join(' | ');
  if (!text) return false;
  return ['summary','total','totals','opening balance','closing balance','transaction count','عدد عمليات','عدد  عمليات','مجموع','الرصيد الافتتاحي','رصيد الافتتاح','رصيد الاغلاق','رصيد الإغلاق'].some((term) => text.includes(term));
}

function detectTransactionTable(rows: PhysicalRow[], physicalFormulaCells: Set<string>): DetectedTable {
  const candidates: { rowIndex: number; profile: HeaderProfile; score: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const profile = profileHeader(rows[i]!.cells);
    if (!profile) continue;
    let valid = 0; let inspected = 0;
    for (let j = i + 1; j < rows.length && inspected < 25; j++) {
      const cells = rows[j]!.cells;
      if (rowIsBlank(cells)) continue;
      if (looksLikeFooter(cells)) break;
      if (profileHeader(cells)) break;
      inspected++;
      if (looksLikeTransaction(cells, profile)) valid++;
    }
    const evidenceRatio = inspected > 0 ? valid / inspected : 0;
    if (valid >= 2 && evidenceRatio >= 0.5) candidates.push({ rowIndex: i, profile, score: profile.score * 100 + Math.min(valid, 25) });
  }
  if (!candidates.length) throw new BankValidationError('Could not confidently detect bank transaction table');
  candidates.sort((a,b) => b.score - a.score || a.rowIndex - b.rowIndex);
  const best = candidates[0]!;

  let lastValid = -1;
  for (let i = best.rowIndex + 1; i < rows.length; i++) if (looksLikeTransaction(rows[i]!.cells, best.profile)) lastValid = i;
  if (lastValid < 0) throw new BankValidationError('Could not confidently detect bank transaction table');

  let end = lastValid;
  for (let i = lastValid + 1; i < rows.length; i++) {
    const row = rows[i]!.cells;
    if (rowIsBlank(row) || looksLikeFooter(row)) break;
    if (profileHeader(row)) continue;
    end = i;
  }

  const dataRows: PhysicalRow[] = [];
  for (let i = best.rowIndex + 1; i <= end; i++) {
    const row = rows[i]!;
    if (rowIsBlank(row.cells)) continue;
    if (profileHeader(row.cells)) continue;
    dataRows.push(row);
  }
  if (!dataRows.length) throw new BankValidationError('Could not confidently detect bank transaction table');

  const headerCells = rows[best.rowIndex]!.cells;
  const headers = headerCells.map((value, i) => String(value ?? `Column ${i + 1}`).trim() || `Column ${i + 1}`);
  const sourceRowNumbers = dataRows.map((row) => row.sourceRowNumber);
  const sourceIndex = new Map(sourceRowNumbers.map((sourceRowNumber, index) => [sourceRowNumber, index]));
  const formulaCells = new Set<string>();
  for (const key of physicalFormulaCells) {
    const [source, column] = key.split(':');
    const index = sourceIndex.get(Number(source));
    if (index !== undefined && column !== undefined) formulaCells.add(`${index}:${column}`);
  }
  return { headers, rows: dataRows.map((row) => row.cells), sourceRowNumbers, formulaCells, detectionScore: best.score };
}

function parseXlsx(data: Buffer): ParsedTable {
  const zip = readZipEntries(data);
  const sharedXml = zip.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const shared: string[] = [];
  for (const match of sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gi)) {
    const pieces = [...match[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi)].map((m) => decodeXml(m[1]!));
    shared.push(pieces.join(''));
  }
  const workbook = zip.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = zip.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relationships = new Map<string,string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>(?:<\/Relationship>)?/gi)) relationships.set(m[1]!, m[2]!);
  const candidates: string[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*(?:r:id|id)="([^"]+)"[^>]*\/?>(?:<\/sheet>)?/gi)) {
    const target = relationships.get(m[1]!);
    if (target) candidates.push(target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`.replace(/xl\/xl\//, 'xl/'));
  }
  if (!candidates.length) candidates.push('xl/worksheets/sheet1.xml');
  let selected: DetectedTable | null = null;
  let ambiguous = false;
  for (const sheetPath of candidates) {
    const xml = zip.get(sheetPath)?.toString('utf8');
    if (!xml) continue;
    const rows: PhysicalRow[] = []; const formulaCells = new Set<string>();
    let fallbackRow = 1;
    for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
      const rowAttrs = rowMatch[1]!; const rowBody = rowMatch[2]!;
      const sourceRowNumber = Number(rowAttrs.match(/\br="(\d+)"/i)?.[1] ?? fallbackRow);
      fallbackRow = sourceRowNumber + 1;
      const row: Cell[] = [];
      for (const cellMatch of rowBody.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attrs = cellMatch[1]!; const body = cellMatch[2]!;
        const ref = attrs.match(/\br="([^"]+)"/i)?.[1] ?? `A${sourceRowNumber}`;
        const index = colIndex(ref); const type = attrs.match(/\bt="([^"]+)"/i)?.[1] ?? 'n';
        if (/<f(?:\s|>)/i.test(body)) formulaCells.add(`${sourceRowNumber}:${index}`);
        let value: Cell = null;
        if (type === 'inlineStr') value = xmlTag(body, 't');
        else {
          const raw = xmlTag(body, 'v');
          if (raw !== null) {
            if (type === 's') value = shared[Number(raw)] ?? '';
            else if (type === 'str') value = raw;
            else value = Number.isFinite(Number(raw)) ? Number(raw) : raw;
          }
        }
        row[index] = value;
      }
      rows.push({ sourceRowNumber, cells: row });
    }
    if (!rows.some((row) => !rowIsBlank(row.cells))) continue;
    try {
      const detected = detectTransactionTable(rows, formulaCells);
      if (!selected || detected.detectionScore > selected.detectionScore) { selected = detected; ambiguous = false; }
      else if (detected.detectionScore === selected.detectionScore) ambiguous = true;
    } catch (err) {
      if (!(err instanceof BankValidationError)) throw err;
    }
  }
  if (!selected) throw new BankValidationError('Could not confidently detect bank transaction table');
  if (ambiguous) throw new BankValidationError('Ambiguous bank transaction table');
  const { detectionScore: _score, ...table } = selected;
  return table;
}

export function parseBankFile(format: SourceFormat, data: Buffer): ParsedTable {
  if (format === 'csv') {
    const rows = parseCsvText(decodeCsv(data));
    const physicalRows = rows.map((cells, index) => ({ sourceRowNumber: index + 1, cells }));
    if (!physicalRows.some((row) => !rowIsBlank(row.cells))) throw new BankValidationError('CSV is empty');
    const { detectionScore: _score, ...table } = detectTransactionTable(physicalRows, new Set());
    if (table.rows.length > MAX_ROWS) throw new BankValidationError('Bank import exceeds row limit');
    return table;
  }
  const table = parseXlsx(data);
  if (table.rows.length > MAX_ROWS) throw new BankValidationError('Bank import exceeds row limit');
  return table;
}

function normalizeText(value: Cell): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().replace(/\s+/g, ' ');
  return text || null;
}

function normalizeMoney(value: Cell, allowBlank = false): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return allowBlank ? null : null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value.toFixed(2);
  }
  let text = String(value).trim();
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  text = text.replace(/[\s,٬]/g, '').replace(/٫/g, '.');
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || Math.abs(amount) >= 1e16) return null;
  return (negative ? -Math.abs(amount) : amount).toFixed(2);
}

function excelSerialDate(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0 || value > 2_958_465) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.floor(value) * 86400000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function normalizeDate(value: Cell, format: DateFormat): string | null {
  if (typeof value === 'number') return excelSerialDate(value);
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  let y: string, m: string, d: string;
  let match: RegExpMatchArray | null;
  if (format === 'YYYY-MM-DD') { match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!match) return null; [,y,m,d] = match as [string,string,string,string]; }
  else if (format === 'DD/MM/YYYY') { match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if (!match) return null; [,d,m,y] = match as [string,string,string,string]; }
  else { match = text.match(/^(\d{2})-(\d{2})-(\d{4})$/); if (!match) return null; [,d,m,y] = match as [string,string,string,string]; }
  const iso = `${y!}-${m!}-${d!}`; const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === iso ? iso : null;
}

function hashParts(parts: (string | null)[]): string {
  return crypto.createHash('sha256').update(parts.map((v) => v ?? '').join('\u001f')).digest('hex');
}

class BankRepository {
  constructor(private readonly db: Pool) {}
  async accounts(companyId: string): Promise<BankAccount[]> {
    const { rows } = await this.db.query<BankAccount>('SELECT * FROM bank_accounts WHERE company_id=$1 ORDER BY created_at, id', [companyId]); return rows;
  }
  async createAccount(input: { companyId: string; actor: string; displayName: string; bankName: string | null; currency: string }, client: PoolClient): Promise<BankAccount> {
    const { rows } = await client.query<BankAccount>('INSERT INTO bank_accounts(company_id,display_name,bank_name,currency_code,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [input.companyId,input.displayName,input.bankName,input.currency,input.actor]); return rows[0]!;
  }
  async account(id: string, companyId: string): Promise<BankAccount | null> {
    const { rows } = await this.db.query<BankAccount>('SELECT * FROM bank_accounts WHERE id=$1 AND company_id=$2', [id,companyId]); return rows[0] ?? null;
  }
  async batches(companyId: string): Promise<BankBatch[]> {
    const { rows } = await this.db.query<BankBatch>('SELECT * FROM bank_import_batches WHERE company_id=$1 ORDER BY created_at DESC', [companyId]); return rows;
  }
  async batch(id: string, companyId: string, client?: PoolClient, lock=false): Promise<BankBatch | null> {
    const db = client ?? this.db; const { rows } = await db.query<BankBatch>(`SELECT * FROM bank_import_batches WHERE id=$1 AND company_id=$2${lock ? ' FOR UPDATE' : ''}`, [id,companyId]); return rows[0] ?? null;
  }
  async batchByHash(companyId: string, hash: string): Promise<BankBatch | null> {
    const { rows } = await this.db.query<BankBatch>('SELECT * FROM bank_import_batches WHERE company_id=$1 AND file_sha256=$2', [companyId,hash]); return rows[0] ?? null;
  }
  async createBatch(input: { companyId:string; accountId:string; actor:string; filename:string; mime:string; format:SourceFormat; storageKey:string; hash:string }, client: PoolClient): Promise<BankBatch> {
    const { rows } = await client.query<BankBatch>(`INSERT INTO bank_import_batches(company_id,bank_account_id,original_filename,mime_type,source_format,storage_key,file_sha256,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'mapping_required',$8) RETURNING *`, [input.companyId,input.accountId,input.filename,input.mime,input.format,input.storageKey,input.hash,input.actor]); return rows[0]!;
  }
  async savePreview(batchId:string, companyId:string, mapping:BankColumnMapping, result:PreviewResult, client:PoolClient): Promise<BankBatch> {
    const { rows } = await client.query<BankBatch>(`UPDATE bank_import_batches SET status='preview_ready', column_mapping=$3,total_rows=$4,valid_rows=$5,duplicate_rows=$6,invalid_rows=$7 WHERE id=$1 AND company_id=$2 RETURNING *`, [batchId,companyId,mapping,result.totalRows,result.validRows,result.duplicateRows,result.invalidRows]); return rows[0]!;
  }
  async fingerprints(companyId:string, accountId:string, fps:string[]): Promise<Set<string>> {
    if (!fps.length) return new Set();
    const { rows } = await this.db.query<{fingerprint:string}>('SELECT DISTINCT fingerprint FROM bank_transactions WHERE company_id=$1 AND bank_account_id=$2 AND fingerprint = ANY($3::text[])',[companyId,accountId,fps]); return new Set(rows.map((r)=>r.fingerprint));
  }
  async fingerprintsTx(companyId:string, accountId:string, fps:string[], client:PoolClient): Promise<Set<string>> {
    if (!fps.length) return new Set();
    const { rows } = await client.query<{fingerprint:string}>('SELECT DISTINCT fingerprint FROM bank_transactions WHERE company_id=$1 AND bank_account_id=$2 AND fingerprint = ANY($3::text[])',[companyId,accountId,fps]); return new Set(rows.map((r)=>r.fingerprint));
  }
  async insertTransaction(input: NormalizedTransaction & { companyId:string; accountId:string; batchId:string; currency:string }, client:PoolClient): Promise<boolean> {
    const result = await client.query(`INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,value_date,amount,currency_code,description,bank_reference,running_balance,source_row_number,fingerprint,fingerprint_strength) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`, [input.companyId,input.accountId,input.batchId,input.transaction_date,input.value_date,input.amount,input.currency,input.description,input.bank_reference,input.running_balance,input.source_row_number,input.fingerprint,input.fingerprint_strength]); return (result.rowCount ?? 0) === 1;
  }
  async confirmBatch(batchId:string, companyId:string, actor:string, counts:{valid:number;duplicates:number}, client:PoolClient): Promise<BankBatch> {
    const { rows } = await client.query<BankBatch>(`UPDATE bank_import_batches SET status='confirmed',valid_rows=$3,duplicate_rows=$4,confirmed_by=$5,confirmed_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`, [batchId,companyId,counts.valid,counts.duplicates,actor]); return rows[0]!;
  }
  async transactions(companyId:string): Promise<unknown[]> {
    const { rows } = await this.db.query('SELECT * FROM bank_transactions WHERE company_id=$1 ORDER BY transaction_date DESC, created_at DESC, id',[companyId]); return rows;
  }
}

export class BankService {
  private readonly repo: BankRepository;
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool, private readonly files: StorageAdapter) { this.repo = new BankRepository(db); }
  private async tx<T>(fn:(client:PoolClient)=>Promise<T>): Promise<T> { const client=await this.db.connect(); try { await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result; } catch(err){ await client.query('ROLLBACK'); throw err; } finally { client.release(); } }

  listAccounts(companyId:string){ return this.repo.accounts(companyId); }
  listBatches(companyId:string){ return this.repo.batches(companyId); }
  listTransactions(companyId:string){ return this.repo.transactions(companyId); }

  async createAccount(input:{companyId:string;actor:string;displayName:string;bankName:string|null;currency:string}) {
    return this.tx(async(client)=>{ const account=await this.repo.createAccount(input,client); await this.audit.logEvent({company_id:input.companyId,actor_user_id:input.actor,action:'bank_account.create',entity_type:'bank_account',entity_id:account.id,before_data:null,after_data:{display_name:account.display_name,bank_name:account.bank_name,currency_code:account.currency_code,is_active:account.is_active}},client); return account; });
  }

  async upload(input:{companyId:string;actor:string;accountId:string;filename:string;mime:string;format:SourceFormat;data:Buffer}) {
    const account=await this.repo.account(input.accountId,input.companyId); if(!account) throw new BankNotFoundError('Bank account not found'); if(!account.is_active) throw new BankConflictError('Bank account is inactive');
    const table=parseBankFile(input.format,input.data);
    const hash=crypto.createHash('sha256').update(input.data).digest('hex');
    const existing=await this.repo.batchByHash(input.companyId,hash); if(existing) throw new DuplicateBankImportError(existing);
    const storageKey=`${input.companyId}/${crypto.randomUUID()}`; await this.files.put(storageKey,input.data);
    try { const batch=await this.tx((client)=>this.repo.createBatch({companyId:input.companyId,accountId:input.accountId,actor:input.actor,filename:input.filename,mime:input.mime,format:input.format,storageKey,hash},client)); return {batch,columns:table.headers,sample:table.rows.slice(0,5)}; }
    catch(err){ await this.files.delete(storageKey).catch(()=>undefined); if((err as {code?:string}).code==='23505'){ const duplicate=await this.repo.batchByHash(input.companyId,hash); if(duplicate) throw new DuplicateBankImportError(duplicate); } throw err; }
  }

  private normalize(table:ParsedTable,mapping:BankColumnMapping,account:BankAccount,existing:Set<string>): PreviewResult {
    const results:NormalizedTransaction[]=[]; let valid=0,duplicate=0,possible=0,invalid=0;
    const mappedIndices=[mapping.transaction_date,mapping.amount,mapping.debit,mapping.credit,mapping.value_date,mapping.description,mapping.bank_reference,mapping.running_balance].filter(Boolean).map((r)=>r!.index);
    for(let i=0;i<table.rows.length;i++){
      const row=table.rows[i]!; const source=table.sourceRowNumbers[i] ?? i+2;
      const formula=mappedIndices.some((idx)=>table.formulaCells.has(`${i}:${idx}`));
      let error:string|null=null;
      const date=normalizeDate(row[mapping.transaction_date.index] ?? null,mapping.date_format); if(!date) error='Invalid date';
      const valueDate=mapping.value_date ? normalizeDate(row[mapping.value_date.index] ?? null,mapping.date_format) : null;
      if(mapping.value_date && row[mapping.value_date.index] != null && !valueDate) error=error ?? 'Invalid value date';
      let amount:string|null=null;
      if(mapping.amount_mode==='signed') amount=normalizeMoney(row[mapping.amount!.index] ?? null);
      else {
        const debit=normalizeMoney(row[mapping.debit!.index] ?? null,true); const credit=normalizeMoney(row[mapping.credit!.index] ?? null,true);
        if(debit!==null && credit!==null && Number(debit)!==0 && Number(credit)!==0) error=error ?? 'Debit and credit both populated';
        else if(debit!==null && Number(debit)!==0) amount=(-Math.abs(Number(debit))).toFixed(2);
        else if(credit!==null && Number(credit)!==0) amount=Math.abs(Number(credit)).toFixed(2);
      }
      if(!amount || Number(amount)===0) error=error ?? 'Missing or invalid amount';
      const description=mapping.description ? normalizeText(row[mapping.description.index] ?? null) : null;
      const reference=mapping.bank_reference ? normalizeText(row[mapping.bank_reference.index] ?? null) : null;
      const balance=mapping.running_balance ? normalizeMoney(row[mapping.running_balance.index] ?? null,true) : null;
      if(mapping.running_balance && row[mapping.running_balance.index] != null && String(row[mapping.running_balance.index]).trim()!=='' && balance===null) error=error ?? 'Invalid running balance';
      if(formula) error='Formula cells are not allowed';
      const strong=Boolean(reference); const fingerprint=strong ? hashParts([account.id,date,amount,reference]) : hashParts([account.id,date,amount,description,balance]);
      let status:NormalizedTransaction['status']='valid';
      if(error){status='invalid';invalid++;} else if(existing.has(fingerprint)&&strong){status='duplicate';duplicate++;} else if(existing.has(fingerprint)){status='possible_duplicate';possible++;valid++;} else valid++;
      results.push({source_row_number:source,transaction_date:date??'',value_date:valueDate,amount:amount??'',description,bank_reference:reference,running_balance:balance,fingerprint,fingerprint_strength:strong?'strong':'weak',status,error});
    }
    return {totalRows:results.length,validRows:valid,duplicateRows:duplicate,possibleDuplicateRows:possible,invalidRows:invalid,rows:results};
  }

  async preview(batchId:string,companyId:string,mappingOverride?:BankColumnMapping):Promise<PreviewResult>{
    const batch=await this.repo.batch(batchId,companyId); if(!batch) throw new BankNotFoundError('Bank import not found');
    const mapping=mappingOverride ?? batch.column_mapping; if(!mapping) throw new BankConflictError('Column mapping required');
    const account=await this.repo.account(batch.bank_account_id,companyId); if(!account) throw new BankNotFoundError('Bank account not found');
    const table=parseBankFile(batch.source_format,await this.files.get(batch.storage_key));
    const refs=[...new Set(table.rows.map((row)=>{
      const date=normalizeDate(row[mapping.transaction_date.index]??null,mapping.date_format); let amount:string|null=null;
      if(mapping.amount_mode==='signed') amount=normalizeMoney(row[mapping.amount!.index]??null);
      else { const d=normalizeMoney(row[mapping.debit!.index]??null,true); const c=normalizeMoney(row[mapping.credit!.index]??null,true); if(d&&Number(d)!==0) amount=(-Math.abs(Number(d))).toFixed(2); else if(c&&Number(c)!==0) amount=Math.abs(Number(c)).toFixed(2); }
      const ref=mapping.bank_reference?normalizeText(row[mapping.bank_reference.index]??null):null; const desc=mapping.description?normalizeText(row[mapping.description.index]??null):null; const bal=mapping.running_balance?normalizeMoney(row[mapping.running_balance.index]??null,true):null;
      return ref?hashParts([account.id,date,amount,ref]):hashParts([account.id,date,amount,desc,bal]);
    }))];
    const existing=await this.repo.fingerprints(companyId,account.id,refs); return this.normalize(table,mapping,account,existing);
  }

  async saveMapping(batchId:string,companyId:string,actor:string,mapping:BankColumnMapping){
    const current=await this.repo.batch(batchId,companyId); if(!current) throw new BankNotFoundError('Bank import not found'); if(current.status==='confirmed') throw new BankConflictError('Bank import already confirmed');
    const preview=await this.preview(batchId,companyId,mapping);
    return this.tx(async(client)=>{ const batch=await this.repo.savePreview(batchId,companyId,mapping,preview,client); await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'bank_import.preview',entity_type:'bank_import_batch',entity_id:batch.id,before_data:{status:current.status},after_data:{status:batch.status,total_rows:preview.totalRows,valid_rows:preview.validRows,duplicate_rows:preview.duplicateRows,invalid_rows:preview.invalidRows}},client); return {batch,preview:{...preview,rows:preview.rows.slice(0,MAX_PREVIEW_ROWS)}}; });
  }

  async confirm(batchId:string,companyId:string,actor:string){
    return this.tx(async(client)=>{
      const batch=await this.repo.batch(batchId,companyId,client,true); if(!batch) throw new BankNotFoundError('Bank import not found'); if(batch.status==='confirmed') return {batch,importedRows:batch.valid_rows,duplicateRows:batch.duplicate_rows,idempotent:true}; if(!batch.column_mapping||batch.status!=='preview_ready') throw new BankConflictError('Preview required before confirm');
      const accountResult=await client.query<BankAccount>('SELECT * FROM bank_accounts WHERE id=$1 AND company_id=$2',[batch.bank_account_id,companyId]); const account=accountResult.rows[0]; if(!account) throw new BankNotFoundError('Bank account not found'); if(!account.is_active) throw new BankConflictError('Bank account is inactive');
      const table=parseBankFile(batch.source_format,await this.files.get(batch.storage_key)); const provisional=this.normalize(table,batch.column_mapping,account,new Set()); const existing=await this.repo.fingerprintsTx(companyId,account.id,provisional.rows.map((r)=>r.fingerprint),client); const preview=this.normalize(table,batch.column_mapping,account,existing); if(preview.invalidRows>0) throw new BankConflictError('Bank import contains invalid rows');
      let imported=0; let duplicates=0;
      for(const row of preview.rows){ if(row.status==='duplicate'){duplicates++;continue;} const inserted=await this.repo.insertTransaction({...row,companyId,accountId:account.id,batchId:batch.id,currency:account.currency_code},client); if(inserted) imported++; else duplicates++; }
      const confirmed=await this.repo.confirmBatch(batch.id,companyId,actor,{valid:imported,duplicates},client); await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'bank_import.confirm',entity_type:'bank_import_batch',entity_id:batch.id,before_data:{status:batch.status},after_data:{status:'confirmed',bank_account_id:account.id,file_sha256:batch.file_sha256,total_rows:preview.totalRows,imported_rows:imported,duplicate_rows:duplicates}},client); return {batch:confirmed,importedRows:imported,duplicateRows:duplicates,idempotent:false};
    });
  }
}

bankRouter.get('/bank-accounts', requireAuth, requireActiveCompany, requireCapability(VIEW), asyncRoute(async(req,res)=>{ const c=activeContext(req,res); if(!c)return; const s=serviceOr503(res); if(!s)return; res.json({accounts:await s.listAccounts(c.activeCompanyId)}); }));
bankRouter.post('/bank-accounts', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(MANAGE), asyncRoute(async(req,res)=>{ const c=activeContext(req,res); if(!c)return; const body=parseAccountBody(req.body); if(!body){res.status(400).json({error:'Invalid bank account'});return;} const s=serviceOr503(res); if(!s)return; const account=await s.createAccount({companyId:c.activeCompanyId,actor:c.user.id,displayName:body.displayName,bankName:body.bankName,currency:body.currencyCode}); res.status(201).json({account}); }));
bankRouter.get('/bank-import-batches', requireAuth, requireActiveCompany, requireCapability(VIEW), asyncRoute(async(req,res)=>{ const c=activeContext(req,res); if(!c)return; const s=serviceOr503(res); if(!s)return; res.json({batches:await s.listBatches(c.activeCompanyId)}); }));
bankRouter.post('/bank-import-batches', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(IMPORT), parseUploadBody, asyncRoute(async(req,res)=>{ const c=activeContext(req,res); if(!c)return; const filename=decodeFilename(req.headers['x-file-name']); const accountId=typeof req.headers['x-bank-account-id']==='string'?req.headers['x-bank-account-id'].trim():''; const mime=String(req.headers['content-type']??'').split(';')[0]!.trim().toLowerCase(); const data=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0); const format=filename?uploadFormat(filename,mime,data):null; if(!filename||!accountId||!format){res.status(400).json({error:'Invalid bank import'});return;} const s=serviceOr503(res); if(!s)return; try{const result=await s.upload({companyId:c.activeCompanyId,actor:c.user.id,accountId,filename,mime,format,data});res.status(201).json(result);}catch(err){if(err instanceof DuplicateBankImportError){res.status(409).json({error:'Duplicate bank import',existingBatchId:err.batch.id,existingBatchStatus:err.batch.status});return;}if(err instanceof BankNotFoundError){res.status(404).json({error:'Bank account not found'});return;}if(err instanceof BankConflictError){res.status(409).json({error:err.message});return;}if(err instanceof BankValidationError){res.status(400).json({error:err.message});return;}throw err;} }));
bankRouter.patch('/bank-import-batches/:id/mapping', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(IMPORT), asyncRoute(async(req,res)=>{const c=activeContext(req,res);if(!c)return;const mapping=parseMapping(req.body);if(!mapping){res.status(400).json({error:'Invalid column mapping'});return;}const s=serviceOr503(res);if(!s)return;try{res.json(await s.saveMapping(req.params.id,c.activeCompanyId,c.user.id,mapping));}catch(err){if(err instanceof BankNotFoundError){res.status(404).json({error:'Bank import not found'});return;}if(err instanceof BankConflictError){res.status(409).json({error:err.message});return;}if(err instanceof BankValidationError){res.status(400).json({error:err.message});return;}throw err;}}));
bankRouter.get('/bank-import-batches/:id/preview', requireAuth, requireActiveCompany, requireCapability(IMPORT), asyncRoute(async(req,res)=>{const c=activeContext(req,res);if(!c)return;const s=serviceOr503(res);if(!s)return;try{const preview=await s.preview(req.params.id,c.activeCompanyId);res.json({...preview,rows:preview.rows.slice(0,MAX_PREVIEW_ROWS)});}catch(err){if(err instanceof BankNotFoundError){res.status(404).json({error:'Bank import not found'});return;}if(err instanceof BankConflictError){res.status(409).json({error:err.message});return;}throw err;}}));
bankRouter.post('/bank-import-batches/:id/confirm', requireSameOrigin, requireAuth, requireActiveCompany, requireCapability(IMPORT), asyncRoute(async(req,res)=>{const c=activeContext(req,res);if(!c)return;const s=serviceOr503(res);if(!s)return;try{res.json(await s.confirm(req.params.id,c.activeCompanyId,c.user.id));}catch(err){if(err instanceof BankNotFoundError){res.status(404).json({error:'Bank import not found'});return;}if(err instanceof BankConflictError){res.status(409).json({error:err.message});return;}if(err instanceof BankValidationError){res.status(400).json({error:err.message});return;}throw err;}}));
bankRouter.get('/bank-transactions', requireAuth, requireActiveCompany, requireCapability(VIEW), asyncRoute(async(req,res)=>{const c=activeContext(req,res);if(!c)return;const s=serviceOr503(res);if(!s)return;res.json({transactions:await s.listTransactions(c.activeCompanyId)});}));