'use strict';
// EQFAL backup/restore helpers. Dependency-free (Node built-ins + system pg_dump/pg_restore/tar).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { PassThrough, Transform } = require('stream');

const MAGIC = Buffer.from('EQFALBK1');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1, keyLen: 32 };
const MIN_PASSPHRASE_LENGTH = 16;
const BACKUP_DIR_RE = /^eqfal-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

class BackupError extends Error {}

// ---------- passphrase / keys ----------
function readPassphrase(env = process.env) {
  let value;
  if (env.BACKUP_PASSPHRASE_FILE) {
    const st = fs.statSync(env.BACKUP_PASSPHRASE_FILE);
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      throw new BackupError('BACKUP_PASSPHRASE_FILE must not be readable by group/others (chmod 600)');
    }
    value = fs.readFileSync(env.BACKUP_PASSPHRASE_FILE, 'utf8').replace(/[\r\n]+$/, '');
  } else if (env.BACKUP_PASSPHRASE) {
    value = env.BACKUP_PASSPHRASE;
  } else {
    throw new BackupError('Set BACKUP_PASSPHRASE_FILE (preferred) or BACKUP_PASSPHRASE');
  }
  if (value.length < MIN_PASSPHRASE_LENGTH) {
    throw new BackupError(`Backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  return value;
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, KDF.keyLen, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 128 * 1024 * 1024 });
}

// ---------- hashing helpers ----------
function hashingTransform(hash) {
  let bytes = 0;
  const t = new Transform({
    transform(chunk, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); },
  });
  t.byteCount = () => bytes;
  return t;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hashingTransform(hash).on('data', () => {}));
  return hash.digest('hex');
}

// ---------- encryption (AES-256-GCM, authenticated; header is AAD) ----------
// File layout: MAGIC(8) | salt(16) | iv(12) | ciphertext | tag(16)
async function encryptStream(source, destPath, passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  cipher.setAAD(header);
  const plainHash = crypto.createHash('sha256');
  const encHash = crypto.createHash('sha256');
  const plainT = hashingTransform(plainHash);
  const fd = fs.openSync(destPath, 'wx', 0o600);
  const out = fs.createWriteStream(null, { fd });
  encHash.update(header);
  out.write(header);
  const encT = hashingTransform(encHash);
  try {
    await pipeline(source, plainT, cipher, encT, out, { end: false });
    const tag = cipher.getAuthTag();
    encHash.update(tag);
    await new Promise((resolve, reject) => out.end(tag, (e) => (e ? reject(e) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(destPath, { force: true });
    throw err;
  }
  return {
    plain_sha256: plainHash.digest('hex'),
    plain_bytes: plainT.byteCount(),
    encrypted_sha256: encHash.digest('hex'),
    encrypted_bytes: HEADER_LEN + encT.byteCount() + TAG_LEN,
  };
}

// Returns a readable stream of plaintext. Authentication failure surfaces as a stream error at the end,
// so callers must consume the whole stream and treat any error as a failed (untrusted) read.
function decryptStream(srcPath, passphrase) {
  const size = fs.statSync(srcPath).size;
  if (size < HEADER_LEN + TAG_LEN) throw new BackupError('Encrypted file is truncated');
  const fd = fs.openSync(srcPath, 'r');
  const header = Buffer.alloc(HEADER_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  try {
    fs.readSync(fd, header, 0, HEADER_LEN, 0);
    fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally { fs.closeSync(fd); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError('Not an EQFAL backup file (bad magic)');
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = header.subarray(MAGIC.length + SALT_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const body = fs.createReadStream(srcPath, { start: HEADER_LEN, end: size - TAG_LEN - 1 });
  const out = new PassThrough();
  const plainHash = crypto.createHash('sha256');
  const counter = hashingTransform(plainHash);
  pipeline(body, decipher, counter, out).catch((err) => {
    out.destroy(new BackupError(`Decryption/authentication failed: ${err.message}`));
  });
  out.plainResult = () => ({ plain_sha256: plainHash.digest('hex'), plain_bytes: counter.byteCount() });
  return out;
}

// ---------- process helpers ----------
function spawnProc(cmd, args, { env, stdin = 'ignore' } = {}) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: [stdin, 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d.toString(); });
  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new BackupError(`${cmd} could not start: ${e.message}`)));
    child.on('close', (code) => resolve({ code, stderr }));
  });
  return { child, done };
}

async function runToCompletion(cmd, args, opts) {
  const p = spawnProc(cmd, args, opts);
  p.child.stdout.resume();
  const { code, stderr } = await p.done;
  if (code !== 0) throw new BackupError(`${cmd} failed (exit ${code}): ${stderr.trim().slice(0, 500)}`);
  return stderr;
}

// ---------- database connection ----------
function parseDbUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new BackupError('Invalid database URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new BackupError('Database URL must be postgres://');
  return {
    host: decodeURIComponent(u.hostname) || (u.searchParams.get('host') ?? ''),
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

// Credentials go through the environment, never argv (argv is visible in `ps`).
function pgEnv(url) {
  const c = parseDbUrl(url);
  const env = { PGDATABASE: c.database, PGPORT: c.port };
  if (c.host) env.PGHOST = c.host;
  if (c.user) env.PGUSER = c.user;
  if (c.password) env.PGPASSWORD = c.password;
  return env;
}

// ---------- tar ----------
function tarCreateStream(dir) {
  const args = fs.existsSync(dir)
    ? ['-czf', '-', '-C', dir, '.']
    : ['-czf', '-', '--files-from=/dev/null'];
  const p = spawnProc('tar', args);
  return { stream: p.child.stdout, done: p.done };
}

function checkTarListing(listing) {
  const entries = [];
  for (const line of listing.split('\n').filter(Boolean)) {
    const type = line[0];
    if (type !== '-' && type !== 'd') throw new BackupError(`Archive contains a non-regular entry (${type}); refusing`);
    // tar -tv: perms owner size date time name
    const name = line.replace(/^\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+/, '');
    if (name.startsWith('/') || name.split('/').includes('..')) throw new BackupError(`Unsafe path in archive: ${name}`);
    if (type === '-') entries.push(name);
  }
  return entries;
}

async function listAndCheckTar(plainStream) {
  const p = spawnProc('tar', ['-tvzf', '-'], { stdin: 'pipe' });
  let out = '';
  p.child.stdout.on('data', (d) => { out += d.toString(); });
  p.child.stdin.on('error', () => {});
  await pipeline(plainStream, p.child.stdin).catch(() => {});
  const { code, stderr } = await p.done;
  if (code !== 0) throw new BackupError(`tar listing failed: ${stderr.trim().slice(0, 300)}`);
  return checkTarListing(out);
}

async function extractTar(plainStream, destDir) {
  const p = spawnProc('tar', ['-xzf', '-', '-C', destDir, '--no-same-owner', '--no-same-permissions'], { stdin: 'pipe' });
  p.child.stdout.resume();
  p.child.stdin.on('error', () => {});
  await pipeline(plainStream, p.child.stdin).catch(() => {});
  const { code, stderr } = await p.done;
  if (code !== 0) throw new BackupError(`tar extract failed: ${stderr.trim().slice(0, 300)}`);
}

// ---------- filesystem ----------
function walkFiles(root) {
  const out = [];
  const rec = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) throw new BackupError(`Symlink found in storage: ${full}`);
      if (ent.isDirectory()) rec(full);
      else if (ent.isFile()) out.push({ key: path.relative(root, full).split(path.sep).join('/'), size: fs.statSync(full).size });
    }
  };
  if (fs.existsSync(root)) rec(root);
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function nearestExisting(p) {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) cur = path.dirname(cur);
  return fs.realpathSync(cur) + path.resolve(p).slice(cur.length);
}

// ---------- manifest ----------
function canonical(obj) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(obj));
}

function manifestMac(manifest, passphrase) {
  const { manifest_mac: _ignored, ...body } = manifest;
  const salt = Buffer.from(manifest.mac_salt, 'hex');
  return crypto.createHmac('sha256', deriveKey(passphrase, salt)).update(canonical(body)).digest('hex');
}

function sealManifest(body, passphrase) {
  const manifest = { ...body, mac_salt: crypto.randomBytes(SALT_LEN).toString('hex') };
  manifest.manifest_mac = manifestMac(manifest, passphrase);
  return manifest;
}

function readAndVerifyManifest(backupDir, passphrase) {
  const file = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(file)) throw new BackupError(`manifest.json not found in ${backupDir}`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.format !== 1 || !manifest.mac_salt || !manifest.manifest_mac) throw new BackupError('Unsupported or malformed manifest');
  const expected = Buffer.from(manifestMac(manifest, passphrase), 'hex');
  const actual = Buffer.from(String(manifest.manifest_mac), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new BackupError('Manifest authentication failed (tampered manifest or wrong passphrase)');
  }
  return manifest;
}

// ---------- retention (7 daily / 4 weekly / 3 monthly) ----------
function parseBackupDirName(name) {
  const m = BACKUP_DIR_RE.exec(name);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

function planRetention(names, policy = { daily: 7, weekly: 4, monthly: 3 }) {
  const items = names.map((name) => ({ name, date: parseBackupDirName(name) })).filter((i) => i.date)
    .sort((a, b) => b.date - a.date);
  const keep = new Map();
  const mark = (item, why) => keep.set(item.name, [...(keep.get(item.name) ?? []), why]);
  const pick = (keyFn, count, label) => {
    const seen = new Set();
    for (const item of items) {
      const k = keyFn(item.date);
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      mark(item, label);
    }
  };
  pick((d) => d.toISOString().slice(0, 10), policy.daily, 'daily');
  pick(isoWeekKey, policy.weekly, 'weekly');
  pick((d) => d.toISOString().slice(0, 7), policy.monthly, 'monthly');
  return {
    keep: items.filter((i) => keep.has(i.name)).map((i) => ({ name: i.name, reasons: keep.get(i.name) })),
    remove: items.filter((i) => !keep.has(i.name)).map((i) => i.name),
  };
}

function utcStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

module.exports = {
  BackupError, KDF, MIN_PASSPHRASE_LENGTH, readPassphrase, deriveKey, sha256File, encryptStream, decryptStream,
  spawnProc, runToCompletion, parseDbUrl, pgEnv, tarCreateStream, checkTarListing, listAndCheckTar, extractTar,
  walkFiles, isInside, nearestExisting, canonical, sealManifest, readAndVerifyManifest, planRetention,
  parseBackupDirName, utcStamp, os, fs, path,
};
