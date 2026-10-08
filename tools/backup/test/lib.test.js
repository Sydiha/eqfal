'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const lib = require('../lib');
const core = require('../core');
const { mkTmp, PASS, sha } = require('./helpers');

const drain = async (s) => { const parts = []; for await (const c of s) parts.push(c); return Buffer.concat(parts); };

test('encrypt/decrypt round trip returns identical bytes and checksums', async () => {
  const dir = mkTmp();
  const data = Buffer.from('رصيد 1500.50 — synthetic payload '.repeat(5000));
  const enc = await lib.encryptStream(Readable.from([data]), path.join(dir, 'a.enc'), PASS);
  assert.equal(enc.plain_sha256, sha(data));
  assert.equal(enc.encrypted_sha256, await lib.sha256File(path.join(dir, 'a.enc')));
  assert.equal(fs.statSync(path.join(dir, 'a.enc')).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(path.join(dir, 'a.enc')).includes('synthetic payload'));
  const plain = lib.decryptStream(path.join(dir, 'a.enc'), PASS);
  assert.deepEqual(await drain(plain), data);
});

test('wrong passphrase, bit-flip and truncation are all rejected', async () => {
  const dir = mkTmp();
  const f = path.join(dir, 'a.enc');
  await lib.encryptStream(Readable.from([Buffer.alloc(100000, 7)]), f, PASS);
  await assert.rejects(drain(lib.decryptStream(f, PASS + 'x')));
  const bytes = fs.readFileSync(f);
  const flipped = Buffer.from(bytes); flipped[5000] ^= 1;
  fs.writeFileSync(path.join(dir, 'flip.enc'), flipped);
  await assert.rejects(drain(lib.decryptStream(path.join(dir, 'flip.enc'), PASS)));
  fs.writeFileSync(path.join(dir, 'trunc.enc'), bytes.subarray(0, bytes.length - 40));
  await assert.rejects(drain(lib.decryptStream(path.join(dir, 'trunc.enc'), PASS)));
  fs.writeFileSync(path.join(dir, 'tiny.enc'), Buffer.from('nope'));
  assert.throws(() => lib.decryptStream(path.join(dir, 'tiny.enc'), PASS), /truncated/);
});

test('decryptToFile rejects a bad authentication tag, removes the output and never reports success', async () => {
  const dir = mkTmp();
  const f = path.join(dir, 'a.enc');
  await lib.encryptStream(Readable.from([Buffer.alloc(50000, 3)]), f, PASS);
  const bytes = fs.readFileSync(f);
  bytes[bytes.length - 1] ^= 1; // only the final tag byte: the whole ciphertext stream is otherwise intact
  fs.writeFileSync(path.join(dir, 'badtag.enc'), bytes);
  await assert.rejects(lib.decryptToFile(path.join(dir, 'badtag.enc'), path.join(dir, 'out'), PASS));
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});

test('passphrase rules: min length and file permissions', () => {
  assert.throws(() => lib.readPassphrase({ BACKUP_PASSPHRASE: 'short' }), /at least/);
  assert.throws(() => lib.readPassphrase({}), /Set BACKUP_PASSPHRASE/);
  const dir = mkTmp();
  const f = path.join(dir, 'pw');
  fs.writeFileSync(f, PASS + '\n', { mode: 0o644 });
  fs.chmodSync(f, 0o644);
  assert.throws(() => lib.readPassphrase({ BACKUP_PASSPHRASE_FILE: f }), /chmod 600/);
  fs.chmodSync(f, 0o600);
  assert.equal(lib.readPassphrase({ BACKUP_PASSPHRASE_FILE: f }), PASS);
});

test('manifest MAC detects tampering and wrong passphrase', () => {
  const dir = mkTmp();
  const m = lib.sealManifest({ format: 2, artifacts: [{ name: 'x', encrypted_sha256: 'a' }] }, PASS);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  assert.ok(lib.readAndVerifyManifest(dir, PASS));
  assert.throws(() => lib.readAndVerifyManifest(dir, PASS + 'z'), /authentication failed/);
  m.artifacts[0].encrypted_sha256 = 'b';
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  assert.throws(() => lib.readAndVerifyManifest(dir, PASS), /authentication failed/);
});

test('retention keeps 7 daily, 4 weekly, 3 monthly and ignores unrelated names', () => {
  const names = [];
  const start = Date.UTC(2026, 0, 1, 2);
  for (let i = 0; i < 200; i++) names.push(`eqfal-backup-${lib.utcStamp(new Date(start + i * 86400000))}`);
  names.push('not-a-backup', 'eqfal-backup-garbage');
  const plan = lib.planRetention(names);
  const kept = plan.keep.map((k) => k.name);
  assert.ok(!kept.includes('not-a-backup'));
  assert.ok(!plan.remove.includes('not-a-backup'));
  const newest = names.slice(0, 200).slice(-7);
  for (const n of newest) assert.ok(kept.includes(n), `daily ${n}`);
  assert.equal(plan.keep.filter((k) => k.reasons.includes('daily')).length, 7);
  assert.equal(plan.keep.filter((k) => k.reasons.includes('weekly')).length, 4);
  assert.equal(plan.keep.filter((k) => k.reasons.includes('monthly')).length, 3);
  assert.ok(kept.length <= 14 && kept.length >= 7);
  assert.equal(plan.keep.length + plan.remove.length, 200);
});

test('prune is a dry run unless --apply, and only touches backup folders with a manifest', () => {
  const root = mkTmp();
  for (let i = 0; i < 12; i++) {
    const d = path.join(root, `eqfal-backup-${lib.utcStamp(new Date(Date.UTC(2026, 5, 1 + i, 1)))}`);
    fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'manifest.json'), '{}');
  }
  fs.mkdirSync(path.join(root, 'eqfal-backup-20200101T000000Z')); // no manifest -> untouched
  fs.mkdirSync(path.join(root, 'other'));
  const dry = core.pruneBackups(root);
  assert.equal(dry.applied, false);
  assert.equal(fs.readdirSync(root).length, 14);
  const res = core.pruneBackups(root, { apply: true });
  assert.ok(res.remove.length > 0);
  assert.ok(fs.existsSync(path.join(root, 'other')));
  assert.ok(fs.existsSync(path.join(root, 'eqfal-backup-20200101T000000Z')));
  assert.equal(fs.readdirSync(root).length, 14 - res.remove.length);
});

test('parseDbUrl/pgEnv keep the password out of argv-style output', () => {
  const env = lib.pgEnv('postgresql://u:p%40ss@localhost:5433/my_test');
  assert.equal(env.PGPASSWORD, 'p@ss');
  assert.equal(env.PGDATABASE, 'my_test');
  assert.throws(() => lib.parseDbUrl('mysql://x'), /postgres/);
});
