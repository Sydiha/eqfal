import { deflateRawSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import { isSafeXlsxArchive } from '../src/modules/banking/xlsx-security';

function zipEntry(name: string, raw: Buffer): Buffer {
  const compressed = deflateRawSync(raw);
  const nameBuffer = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + nameBuffer.length + compressed.length;
  const centralData = Buffer.concat([central, nameBuffer]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBuffer, compressed, centralData, end]);
}

describe('XLSX archive safety', () => {
  it('accepts a small bounded ZIP entry', () => {
    expect(isSafeXlsxArchive(zipEntry('xl/workbook.xml', Buffer.from('<workbook/>')))).toBe(true);
  });

  it('rejects a small compressed entry that expands beyond the per-entry limit', () => {
    const bomb = zipEntry('xl/worksheets/sheet1.xml', Buffer.alloc(8 * 1024 * 1024 + 1, 0x41));
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    expect(isSafeXlsxArchive(bomb)).toBe(false);
  });
});
