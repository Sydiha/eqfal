'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const archive = require('../archive');
const lib = require('../lib');
const { mkTmp, PASS } = require('./helpers');

const collect = async (s) => { const p = []; for await (const c of s) p.push(c); return Buffer.concat(p); };
const sha = (b) => crypto.createHash('sha256').update(b).digest();

function mkStore(files) {
  const root = mkTmp('eqfal-store-');
  for (const [k, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, k)), { recursive: true });
    fs.writeFileSync(path.join(root, k), v);
  }
  return root;
}

// Hand-built (possibly malicious) archive, gzip-compressed.
function raw(entries, { count, trailer = true, extra } = {}) {
  const parts = [archive.MAGIC];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? 'x');
    const hdr = Buffer.from(JSON.stringify(e.header ?? { key: e.key, size: data.length }));
    const len = Buffer.alloc(4); len.writeUInt32BE(hdr.length);
    parts.push(len, hdr, data, e.sha ?? sha(data));
  }
  if (trailer) { const t = Buffer.alloc(8); t.writeUInt32BE(0, 0); t.writeUInt32BE(count ?? entries.length, 4); parts.push(t); }
  if (extra) parts.push(extra);
  return zlib.gzipSync(Buffer.concat(parts));
}
const parse = (buf, dest) => archive.readArchive(Readable.from([buf]), dest);

test('archive round trip preserves every file byte-for-byte', async () => {
  const files = { 'co1/a-1': Buffer.from('alpha'), 'co1/b-2': crypto.randomBytes(3_000_000), 'co2/c-3': Buffer.alloc(0) };
  const root = mkStore(files);
  const gz = await collect(archive.archiveStream(root));
  const dest = path.join(mkTmp(), 'out');
  fs.mkdirSync(dest);
  const entries = await parse(gz, dest);
  assert.equal(entries.length, 3);
  for (const [k, v] of Object.entries(files)) assert.deepEqual(fs.readFileSync(path.join(dest, k)), v);
});

test('regression: tar exit-1 case — a file modified while being archived aborts, nothing is certified', async () => {
  const root = mkStore({ 'co/f1': Buffer.alloc(2_000_000, 1), 'co/f2': 'b' });
  const hooks = { afterRead: (k) => { if (k === 'co/f1') fs.appendFileSync(path.join(root, 'co/f1'), 'late write'); } };
  await assert.rejects(collect(archive.archiveStream(root, { hooks })), archive.ConcurrentChangeError);
});

test('regression: a file removed or replaced while being archived aborts', async () => {
  const root = mkStore({ 'co/f1': 'aaaa', 'co/f2': 'bbbb' });
  await assert.rejects(collect(archive.archiveStream(root, { hooks: { afterRead: (k) => { if (k === 'co/f1') fs.rmSync(path.join(root, 'co/f1')); } } })), /removed during backup/);
  const root2 = mkStore({ 'co/f1': 'aaaa' });
  await assert.rejects(collect(archive.archiveStream(root2, { hooks: { afterRead: () => { fs.rmSync(path.join(root2, 'co/f1')); fs.writeFileSync(path.join(root2, 'co/f1'), 'cccc'); } } })), archive.ConcurrentChangeError);
});

test('files created after the scan are not included and do not fail the archive', async () => {
  const root = mkStore({ 'co/f1': 'aaaa' });
  const stream = archive.archiveStream(root);
  fs.writeFileSync(path.join(root, 'co/new'), 'late arrival');
  const entries = await parse(await collect(stream), null);
  assert.deepEqual(entries.map((e) => e.key), ['co/f1']);
});

test('symlinks in the source store are refused', () => {
  const root = mkStore({ 'co/f1': 'x' });
  fs.symlinkSync('/etc/passwd', path.join(root, 'co/link'));
  assert.throws(() => archive.archiveStream(root), /Symlink/);
});

test('a failing source can never produce a valid-looking archive file (error propagates through gzip + encryption)', async () => {
  const root = mkStore({ 'co/f1': Buffer.alloc(1000, 1), 'co/f2': 'zz' });
  const dir = mkTmp();
  const dest = path.join(dir, 'a.enc');
  const src = archive.archiveStream(root, { hooks: { afterRead: (k) => { if (k === 'co/f2') fs.rmSync(path.join(root, 'co/f2')); } } });
  await assert.rejects(lib.encryptStream(src, dest, PASS));
  assert.equal(fs.existsSync(dest), false);
});

test('hostile entry names are rejected and nothing is written outside (or inside) the destination', async () => {
  const bad = ['../escape', 'a/../../escape', '/abs/path', 'a//b', './a', 'a/./b', '..', 'a/..', 'a\\b', 'a/b\nc', 'é/f', '', 'x'.repeat(600), '.hidden', 'a/-', 'co/ ', 'co/\u0000x'];
  for (const key of bad) {
    const base = mkTmp();
    const dest = path.join(base, 'out');
    fs.mkdirSync(dest);
    await assert.rejects(parse(raw([{ key }]), dest), archive.ArchiveError, `key ${JSON.stringify(key)}`);
    assert.deepEqual(fs.readdirSync(base), ['out']);
    assert.deepEqual(fs.readdirSync(dest), [], `dest untouched for ${JSON.stringify(key)}`);
  }
});

test('structural attacks: duplicates, case-collisions, file/dir conflicts, bad sizes, bad checksums, truncation, trailing data', async () => {
  const cases = [
    ['duplicate', raw([{ key: 'a/b' }, { key: 'a/b' }])],
    ['case collision', raw([{ key: 'a/B' }, { key: 'a/b' }])],
    ['file then dir', raw([{ key: 'a' }, { key: 'a/b' }])],
    ['dir then file', raw([{ key: 'a/b' }, { key: 'a' }])],
    ['extra header field', raw([{ key: 'a', header: { key: 'a', size: 1, mode: 4095 } }])],
    ['negative size', raw([{ key: 'a', header: { key: 'a', size: -1 } }])],
    ['huge size', raw([{ key: 'a', header: { key: 'a', size: 2 ** 50 } }])],
    ['non-integer size', raw([{ key: 'a', header: { key: 'a', size: 1.5 } }])],
    ['bad checksum', raw([{ key: 'a', sha: Buffer.alloc(32) }])],
    ['wrong count', raw([{ key: 'a' }], { count: 5 })],
    ['missing trailer', raw([{ key: 'a' }], { trailer: false })],
    ['trailing data', raw([{ key: 'a' }], { extra: Buffer.from('junk') })],
  ];
  for (const [name, buf] of cases) await assert.rejects(parse(buf, null), archive.ArchiveError, name);
  await assert.rejects(parse(raw([{ key: 'a', data: 'hello' }]).subarray(0, 30), null), 'truncated gzip');
  await assert.rejects(parse(zlib.gzipSync(Buffer.from('NOTANARCHIVE')), null), /Not an EQFAL archive/);
});

test('extraction never follows or overwrites pre-existing filesystem entries', async () => {
  const base = mkTmp();
  const dest = path.join(base, 'out');
  fs.mkdirSync(path.join(dest, 'co'), { recursive: true });
  const outside = path.join(base, 'outside');
  fs.writeFileSync(outside, 'precious');
  fs.symlinkSync(outside, path.join(dest, 'co/f'));
  await assert.rejects(parse(raw([{ key: 'co/f', data: 'overwrite' }]), dest));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'precious');
  // symlinked directory component
  const dest2 = path.join(base, 'out2');
  fs.mkdirSync(dest2);
  fs.symlinkSync(base, path.join(dest2, 'co'));
  await assert.rejects(parse(raw([{ key: 'co/f', data: 'x' }]), dest2), /Symlink/);
  assert.equal(fs.existsSync(path.join(base, 'f')), false);
});

test('extracted files are created 0600 regardless of archive content', async () => {
  const dest = path.join(mkTmp(), 'out');
  fs.mkdirSync(dest);
  await parse(raw([{ key: 'co/f' }]), dest);
  assert.equal(fs.statSync(path.join(dest, 'co/f')).mode & 0o777, 0o600);
});

test('encrypted archive: bit-flip anywhere is detected by validate-only read', async () => {
  const root = mkStore({ 'co/f1': crypto.randomBytes(100000) });
  const dir = mkTmp();
  const f = path.join(dir, 'a.enc');
  await archive.writeArchive(root, f, (s, d) => lib.encryptStream(s, d, PASS));
  const ok = await archive.readArchive(lib.decryptStream(f, PASS), null);
  assert.equal(ok.length, 1);
  const b = fs.readFileSync(f); b[b.length - 1] ^= 1;
  fs.writeFileSync(path.join(dir, 'bad.enc'), b);
  await assert.rejects(archive.readArchive(lib.decryptStream(path.join(dir, 'bad.enc'), PASS), null));
});
