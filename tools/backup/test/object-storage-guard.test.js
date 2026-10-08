'use strict';
// CLI-level fail-closed behaviour of `backup` with Object Storage settings (Task 6C-2B). No database or bucket is contacted.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const cli = path.resolve(__dirname, '..', 'cli.js');
const run = (env) => spawnSync('node', [cli, 'backup', '--out', '/tmp/eqfal-should-not-be-created'], {
  env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://x@127.0.0.1:1/x', BACKUP_PASSPHRASE: 'x'.repeat(24), ...env },
  encoding: 'utf8',
});

test('object backend without an explicit bucket id is refused (default bucket is never used)', () => {
  const r = run({ STORAGE_BACKEND: 'object' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /OBJECT_STORAGE_BUCKET_ID/);
});

test('unknown STORAGE_BACKEND is refused instead of backing up empty local folders', () => {
  const r = run({ STORAGE_BACKEND: 's3' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /STORAGE_BACKEND must be/);
});

test('Replit production with a local backend is refused (its disk is not the data)', () => {
  const r = run({ STORAGE_BACKEND: 'local', REPLIT_DEPLOYMENT: '1' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /Object Storage/);
});
