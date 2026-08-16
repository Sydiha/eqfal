import { inflateRawSync } from 'zlib';

const MAX_XLSX_ENTRIES = 128;
const MAX_XLSX_ENTRY_SIZE = 8 * 1024 * 1024;
const MAX_XLSX_UNCOMPRESSED_SIZE = 24 * 1024 * 1024;

/**
 * Validate ZIP metadata and actual decompression bounds before the banking
 * parser touches an XLSX archive. This is intentionally dependency-free and
 * only accepts the simple ZIP structures supported by the Phase 3A parser.
 */
export function isSafeXlsxArchive(data: Buffer): boolean {
  try {
    let eocd = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
      if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0 || eocd + 22 > data.length) return false;

    const count = data.readUInt16LE(eocd + 10);
    const centralSize = data.readUInt32LE(eocd + 12);
    const centralOffset = data.readUInt32LE(eocd + 16);
    if (count < 1 || count > MAX_XLSX_ENTRIES) return false;
    if (centralOffset + centralSize > eocd || centralOffset >= data.length) return false;

    let cursor = centralOffset;
    let totalExpanded = 0;
    for (let n = 0; n < count; n++) {
      if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== 0x02014b50) return false;
      const method = data.readUInt16LE(cursor + 10);
      const compressedSize = data.readUInt32LE(cursor + 20);
      const uncompressedSize = data.readUInt32LE(cursor + 24);
      const fileNameLength = data.readUInt16LE(cursor + 28);
      const extraLength = data.readUInt16LE(cursor + 30);
      const commentLength = data.readUInt16LE(cursor + 32);
      const localOffset = data.readUInt32LE(cursor + 42);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) return false;
      if (uncompressedSize > MAX_XLSX_ENTRY_SIZE) return false;
      totalExpanded += uncompressedSize;
      if (totalExpanded > MAX_XLSX_UNCOMPRESSED_SIZE) return false;
      if (method !== 0 && method !== 8) return false;
      if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) return false;
      const localNameLength = data.readUInt16LE(localOffset + 26);
      const localExtraLength = data.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      if (start > data.length || compressedSize > data.length - start) return false;
      const payload = data.subarray(start, start + compressedSize);
      const expanded = method === 0 ? Buffer.from(payload) : inflateRawSync(payload, { maxOutputLength: MAX_XLSX_ENTRY_SIZE + 1 });
      if (expanded.length !== uncompressedSize || expanded.length > MAX_XLSX_ENTRY_SIZE) return false;
      cursor += 46 + fileNameLength + extraLength + commentLength;
    }
    return cursor <= centralOffset + centralSize;
  } catch {
    return false;
  }
}
