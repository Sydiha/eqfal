'use strict';
// The backup tool only archives local directories. With Object Storage selected it must refuse (Task 6C-2B adds support).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

test('backup refuses to run when STORAGE_BACKEND=object', () => {
  const cli = path.resolve(__dirname, '..', 'cli.js');
  const r = spawnSync('node', [cli, 'backup', '--out', '/tmp/eqfal-should-not-be-created'], {
    env: { ...process.env, STORAGE_BACKEND: 'object', DATABASE_URL: 'postgresql://x@127.0.0.1:1/x', BACKUP_PASSPHRASE: 'x'.repeat(24) },
    encoding: 'utf8',
  });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /Object Storage/);
  assert.match(r.stderr, /6C-2B/);
});
