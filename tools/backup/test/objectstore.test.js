'use strict';
// Unit tests for Object Storage backup support (Task 6C-2B). No database needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const archive = require('../archive');
const lib = require('../lib');
const os_ = require('../objectstore');
const { FakeObjectClient, sha, mkTmp, PASS } = require('./helpers');

const uuid = () => crypto.randomUUID();
const gunzipAll = async (stream) => { const chunks = []; for await (const c of stream.pipe(zlib.createGunzip())) chunks.push(c); return Buffer.concat(chunks); };

function setup(n = 3) {
  const client = new FakeObjectClient();
  const co = uuid();
  const refs = [];
  for (let i = 0; i < n; i++) {
    const data = Buffer.from(`object ${i} ${uuid()}`);
    const key = `${co}/${uuid()}`;
    client.put(`nonprod/documents/${key}`, data);
    refs.push({ key, sha256: sha(data), size: data.length, data });
  }
  return { client, refs };
}

test('items archive is byte-identical to the directory archive of the same files (format unchanged)', async () => {
  const { refs } = setup(4);
  const dir = mkTmp();
  for (const r of refs) { fs.mkdirSync(path.dirname(path.join(dir, r.key)), { recursive: true }); fs.writeFileSync(path.join(dir, r.key), r.data); }
  const fromDir = await gunzipAll(archive.archiveStream(dir));
  const fromItems = await gunzipAll(archive.archiveItemsStream(refs.map((r) => ({ key: r.key, load: async () => r.data }))));
  assert.ok(fromDir.equals(fromItems));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verified objects round-trip through the existing readArchive/restore path', async () => {
  const { client, refs } = setup(3);
  const items = os_.itemsFor(client, 'nonprod/documents', refs, 'documents');
  const dest = path.join(mkTmp(), 'a.enc');
  const res = await archive.writeItemsArchive(items, dest, (src, d) => lib.encryptStream(src, d, PASS));
  assert.equal(res.files, 3);
  const plain = lib.decryptStream(dest, PASS);
  const out = mkTmp();
  const entries = await archive.readArchive(plain, path.join(out, 'x'));
  assert.equal(entries.length, 3);
  for (const r of refs) assert.deepEqual(fs.readFileSync(path.join(out, 'x', r.key)), r.data);
  assert.ok(client.calls.every(([op]) => op === 'download'), 'only downloads');
});

test('a missing object fails the backup', async () => {
  const { client, refs } = setup(2);
  client.objects.delete(`nonprod/documents/${refs[1].key}`);
  const items = os_.itemsFor(client, 'nonprod/documents', refs, 'documents');
  await assert.rejects(archive.writeItemsArchive(items, path.join(mkTmp(), 'a.enc'), (s, d) => lib.encryptStream(s, d, PASS)), /MISSING/);
});

test('a SHA-256 mismatch fails the backup', async () => {
  const { client, refs } = setup(2);
  client.put(`nonprod/documents/${refs[0].key}`, 'tampered content of different bytes');
  const items = os_.itemsFor(client, 'nonprod/documents', [{ ...refs[0], size: undefined }, refs[1]], 'documents');
  await assert.rejects(archive.writeItemsArchive(items, path.join(mkTmp(), 'a.enc'), (s, d) => lib.encryptStream(s, d, PASS)), /SHA-256 mismatch/);
});

test('same-length corruption is caught by SHA-256 and a size difference is reported', async () => {
  const { client, refs } = setup(1);
  const flipped = Buffer.from(refs[0].data); flipped[0] ^= 1;
  client.put(`nonprod/documents/${refs[0].key}`, flipped);
  await assert.rejects(os_.fetchVerified(client, 'nonprod/documents', refs[0], 'documents'), /SHA-256 mismatch/);
  client.put(`nonprod/documents/${refs[0].key}`, Buffer.concat([refs[0].data, Buffer.from('x')]));
  await assert.rejects(os_.fetchVerified(client, 'nonprod/documents', refs[0], 'documents'), /size mismatch/);
});

test('a service failure is reported as a service error, never as a missing file', async () => {
  const { client, refs } = setup(1);
  client.failWith = 'No such bucket'; // 500 wording
  await assert.rejects(os_.fetchVerified(client, 'nonprod/documents', refs[0], 'documents'), (e) => /object storage error/.test(e.message) && !/MISSING/.test(e.message));
  client.failWith = null;
  client.downloadAsBytes = async () => { throw new Error('socket hang up'); };
  await assert.rejects(os_.fetchVerified(client, 'nonprod/documents', refs[0], 'documents'), /unavailable/);
  // a 404 that is not "No such object" (e.g. missing bucket) must fail closed as a service error
  client.downloadAsBytes = async () => ({ ok: false, error: { message: 'The specified bucket does not exist', statusCode: 404 } });
  await assert.rejects(os_.fetchVerified(client, 'nonprod/documents', refs[0], 'documents'), (e) => /object storage error/.test(e.message) && !/MISSING/.test(e.message));
});

test('unsafe storage keys from the database are rejected before any download', async () => {
  const client = new FakeObjectClient();
  for (const key of ['../etc/passwd', 'a/b', `${uuid()}/../${uuid()}`, '']) {
    await assert.rejects(os_.fetchVerified(client, 'nonprod/documents', { key, sha256: 'x' }, 'documents'), /unsafe storage_key/);
  }
  assert.equal(client.calls.length, 0);
});

test('duplicate references with conflicting checksums are rejected; identical ones are deduplicated', () => {
  const { client, refs } = setup(1);
  assert.equal(os_.itemsFor(client, 'p', [refs[0], refs[0]], 'documents').length, 1);
  assert.throws(() => os_.itemsFor(client, 'p', [refs[0], { ...refs[0], sha256: 'f'.repeat(64) }], 'documents'), /different checksums/);
});

test('object name prefix/label matches server/src/storage/storage.factory.ts', () => {
  const envs = [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'development' }, { REPLIT_DEPLOYMENT: '1' }, { NODE_ENV: 'production', REPL_ID: 'x' }, { REPL_ID: 'x' }];
  const root = path.resolve(__dirname, '../../..');
  const probe = `const { validateStorageConfig } = require('./server/src/storage/storage.factory'); const envs = ${JSON.stringify(envs)}; console.log(JSON.stringify(envs.map(e => validateStorageConfig({ STORAGE_BACKEND: 'object', OBJECT_STORAGE_BUCKET_ID: 'b', OBJECT_STORAGE_BACKUP_SUPPORT_CONFIRMED: 'true', ...e }).settings.environmentLabel)));`;
  const r = spawnSync('npx', ['tsx', '-e', probe], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), envs.map((e) => os_.environmentLabel(e)));
});
