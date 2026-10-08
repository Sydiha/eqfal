'use strict';
// EQFAL storage archive: a tiny, strictly validated container that replaces tar.
//
// Why not tar: GNU tar reports "file changed as we read it" with exit code 1 AFTER it already streamed an
// inconsistent entry, and its listing/extraction cannot be validated in a single trusted pass. This format is
// written and parsed by this code only, so every entry is checked as it is read.
//
// Plaintext layout (then gzip, then AES-GCM):
//   "EQFALAR1"
//   repeat: u32be headerLen (1..4096) | header JSON {"key","size"} | <size bytes> | sha256 (32 bytes)
//   u32be 0 | u32be fileCount
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('EQFALAR1');
const MAX_HEADER = 4096;
const MAX_KEY = 512;
const MAX_FILE_BYTES = 2 ** 40;
// Storage keys are "<uuid>/<uuid>"; allow only plain path segments of safe characters.
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class ArchiveError extends Error {}
class ConcurrentChangeError extends ArchiveError {}

function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY) throw new ArchiveError('Invalid archive entry name');
  const segs = key.split('/');
  for (const s of segs) {
    if (!SEGMENT_RE.test(s) || s === '.' || s === '..') throw new ArchiveError(`Unsafe archive entry name: ${JSON.stringify(key.slice(0, 80))}`);
  }
  return key;
}

function listRegularFiles(root) {
  const out = [];
  const rec = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) throw new ArchiveError(`Symlink in storage: ${full}`);
      if (ent.isDirectory()) rec(full);
      else if (ent.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
      else throw new ArchiveError(`Unsupported file type in storage: ${full}`);
    }
  };
  if (fs.existsSync(root)) rec(root);
  return out.sort();
}

const sig = (st) => `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;

// Archive every file present at scan time. Any file that is removed, replaced or modified while it is read
// aborts the archive (ConcurrentChangeError): we never certify an inconsistent snapshot. Files created after
// the scan are simply not included (they are orphans with respect to an earlier database snapshot).
// `hooks.afterRead(key)` exists for deterministic regression tests only.
function archiveStream(root, { hooks = {}, stats } = {}) {
  const keys = listRegularFiles(root);
  async function* gen() {
    yield MAGIC;
    let count = 0;
    let bytes = 0;
    for (const key of keys) {
      validateKey(key);
      const full = path.join(root, ...key.split('/'));
      let before;
      try { before = fs.lstatSync(full); } catch { throw new ConcurrentChangeError(`File removed during backup: ${key}`); }
      if (!before.isFile()) throw new ArchiveError(`Not a regular file: ${key}`);
      const header = Buffer.from(JSON.stringify({ key, size: before.size }));
      const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
      yield Buffer.concat([len, header]);
      const hash = crypto.createHash('sha256');
      let read = 0;
      const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const buf = Buffer.alloc(1 << 20);
        for (;;) {
          const n = fs.readSync(fd, buf, 0, buf.length, null);
          if (n === 0) break;
          read += n;
          if (read > before.size) throw new ConcurrentChangeError(`File grew during backup: ${key}`);
          hash.update(buf.subarray(0, n));
          yield Buffer.from(buf.subarray(0, n));
        }
        const afterFd = fs.fstatSync(fd);
        if (hooks.afterRead) hooks.afterRead(key);
        let afterPath;
        try { afterPath = fs.lstatSync(full); } catch { throw new ConcurrentChangeError(`File removed during backup: ${key}`); }
        if (read !== before.size || sig(afterFd) !== sig(before) || sig(afterPath) !== sig(before)) {
          throw new ConcurrentChangeError(`File changed during backup: ${key}`);
        }
      } finally { fs.closeSync(fd); }
      yield hash.digest();
      count++; bytes += read;
    }
    const end = Buffer.alloc(8); end.writeUInt32BE(0, 0); end.writeUInt32BE(count, 4);
    yield end;
    if (stats) { stats.files = count; stats.bytes = bytes; }
  }
  const gz = zlib.createGzip();
  const src = Readable.from(gen());
  // pipe() does not forward errors: without this a mid-archive failure would yield a valid-looking truncated gzip.
  src.on('error', (e) => gz.destroy(e));
  src.pipe(gz);
  return gz;
}

// Pull-style byte reader over an async iterable of Buffers.
class ByteReader {
  constructor(iterable) { this.it = iterable[Symbol.asyncIterator](); this.buf = Buffer.alloc(0); this.done = false; }
  async fill(n) {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.it.next();
      if (done) this.done = true; else this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : value;
    }
    if (this.buf.length < n) throw new ArchiveError('Archive is truncated');
  }
  async take(n) { await this.fill(n); const out = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); return out; }
  async takeUpTo(n) { await this.fill(1); const m = Math.min(n, this.buf.length); return this.take(m); }
  async assertEnd() {
    if (this.buf.length) throw new ArchiveError('Unexpected data after archive end');
    const { done } = await this.it.next();
    if (!done) throw new ArchiveError('Unexpected data after archive end');
  }
}

// Parse + fully validate an archive from a plaintext (gzip) readable. When destDir is given, files are written
// there (new files only, O_EXCL, never following symlinks); otherwise data is only validated and discarded.
async function readArchive(gzReadable, destDir) {
  const gunzip = zlib.createGunzip();
  gzReadable.on('error', (e) => gunzip.destroy(e)); // surface source errors (e.g. failed authentication)
  gzReadable.pipe(gunzip);
  const reader = new ByteReader(gunzip);
  if (!(await reader.take(MAGIC.length)).equals(MAGIC)) throw new ArchiveError('Not an EQFAL archive');
  const seen = new Set();
  const entries = [];
  const root = destDir ? path.resolve(destDir) : null;
  for (;;) {
    const len = (await reader.take(4)).readUInt32BE(0);
    if (len === 0) {
      const count = (await reader.take(4)).readUInt32BE(0);
      if (count !== entries.length) throw new ArchiveError('Archive entry count mismatch');
      await reader.assertEnd();
      return entries;
    }
    if (len > MAX_HEADER) throw new ArchiveError('Archive header too large');
    let header;
    try { header = JSON.parse((await reader.take(len)).toString('utf8')); } catch { throw new ArchiveError('Corrupt archive header'); }
    if (!header || typeof header !== 'object' || Object.keys(header).sort().join() !== 'key,size') throw new ArchiveError('Corrupt archive header');
    const key = validateKey(header.key);
    const size = header.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new ArchiveError('Invalid entry size');
    const folded = key.toLowerCase();
    if (seen.has(folded)) throw new ArchiveError(`Duplicate archive entry: ${key}`);
    seen.add(folded);
    // A file may not also be a directory of another entry (and vice versa).
    for (const other of entries) {
      if (other.key.startsWith(key + '/') || key.startsWith(other.key + '/')) throw new ArchiveError(`Conflicting archive entries: ${key}`);
    }

    let fd = null;
    let target = null;
    if (root) {
      target = path.join(root, ...key.split('/'));
      if (!target.startsWith(root + path.sep)) throw new ArchiveError('Entry escapes destination');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      // Re-verify no component is a symlink (the destination was empty, so none should be).
      let cur = root;
      for (const seg of key.split('/').slice(0, -1)) {
        cur = path.join(cur, seg);
        if (fs.lstatSync(cur).isSymbolicLink()) throw new ArchiveError('Symlink found in destination');
      }
      fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    }
    const hash = crypto.createHash('sha256');
    let remaining = size;
    try {
      while (remaining > 0) {
        const chunk = await reader.takeUpTo(Math.min(remaining, 1 << 20));
        hash.update(chunk);
        if (fd !== null) fs.writeSync(fd, chunk);
        remaining -= chunk.length;
      }
    } finally { if (fd !== null) fs.closeSync(fd); }
    const digest = hash.digest();
    if (!digest.equals(await reader.take(32))) throw new ArchiveError(`Checksum mismatch inside archive: ${key}`);
    entries.push({ key, size, sha256: digest.toString('hex') });
  }
}

async function writeArchive(root, destPath, encryptFn, opts) {
  const stats = {};
  const source = archiveStream(root, { ...opts, stats });
  const enc = await encryptFn(source, destPath);
  return { ...enc, files: stats.files, bytes: stats.bytes };
}

module.exports = { ArchiveError, ConcurrentChangeError, validateKey, listRegularFiles, archiveStream, readArchive, writeArchive, MAGIC };
