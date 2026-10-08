'use strict';
// Object Storage backup -> isolated restore round trip (Task 6C-2B). SYNTHETIC data and an in-memory fake bucket only.
// Needs DATABASE_URL to a server where the user can CREATE DATABASE (CI service container / local scratch server).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const core = require('../core');
const { mkTmp, PASS, hasPgTools, withDb, adminExec, seedSynthetic, FakeObjectClient } = require('./helpers');

const adminUrl = process.env.DATABASE_URL;
const required = process.env.REQUIRE_POSTGRES_TESTS === 'true';
const skip = (!adminUrl || !hasPgTools()) && !required ? 'DATABASE_URL or pg_dump/pg_restore not available' : false;
const REPO = path.resolve(__dirname, '../../..');

test('Object Storage backup/restore round trip (synthetic data)', { skip, timeout: 240000 }, async (t) => {
  assert.ok(adminUrl, 'DATABASE_URL is required when REQUIRE_POSTGRES_TESTS=true');
  const run = crypto.randomBytes(4).toString('hex');
  const srcName = `eqfal_bk_osrc_${run}`;
  const dstName = `eqfal_restore_o${run}`;
  const srcUrl = withDb(adminUrl, srcName);
  const dstUrl = withDb(adminUrl, dstName);
  const work = mkTmp();
  const seedDocs = path.join(work, 'seed/documents');
  const seedBank = path.join(work, 'seed/bank');
  const dstDocs = path.join(work, 'dst/documents');
  const dstBank = path.join(work, 'dst/bank');
  const out = path.join(work, 'backups');
  fs.mkdirSync(seedDocs, { recursive: true });
  fs.mkdirSync(seedBank, { recursive: true });

  await adminExec(adminUrl, `CREATE DATABASE ${srcName}`);
  await adminExec(adminUrl, `CREATE DATABASE ${dstName}`);
  await adminExec(adminUrl, `COMMENT ON DATABASE ${dstName} IS '${core.TARGET_MARKER}'`);
  t.after(async () => {
    await adminExec(adminUrl, `DROP DATABASE IF EXISTS ${srcName} WITH (FORCE)`);
    await adminExec(adminUrl, `DROP DATABASE IF EXISTS ${dstName} WITH (FORCE)`);
    fs.rmSync(work, { recursive: true, force: true });
  });

  const mig = spawnSync('npx', ['tsx', 'server/src/db/migrate-cli.ts'], { cwd: REPO, env: { ...process.env, DATABASE_URL: srcUrl }, encoding: 'utf8' });
  assert.equal(mig.status, 0, mig.stderr);
  const seed = await seedSynthetic(srcUrl, seedDocs, seedBank);

  // The files live ONLY in the fake bucket (seed dirs are just a staging area for the seeder and are deleted).
  const client = new FakeObjectClient();
  for (const f of seed.files) client.put(`nonprod/documents/${f.key}`, f.data);
  client.put(`nonprod/bank-imports/${seed.bankKey}`, fs.readFileSync(path.join(seedBank, seed.bankKey)));
  client.put(`nonprod/documents/${seed.company}/${crypto.randomUUID()}`, 'orphan object not referenced by the database');
  fs.rmSync(path.join(work, 'seed'), { recursive: true, force: true });
  const env = { NODE_ENV: 'test' };
  const objectStorage = { client, env };

  const backup = (extra = {}) => core.createBackup({ databaseUrl: srcUrl, documentsDir: path.join(work, 'unused-d'), bankDir: path.join(work, 'unused-b'), outDir: out, passphrase: PASS, objectStorage, ...extra });

  await t.test('failure modes: missing object, tampered object, service error leave no backup behind', async () => {
    const name = `nonprod/documents/${seed.files[1].key}`;
    const good = client.objects.get(name);
    client.objects.delete(name);
    await assert.rejects(backup(), /MISSING/);
    const bad = Buffer.from(good); bad[0] ^= 1;
    client.put(name, bad);
    await assert.rejects(backup(), /SHA-256 mismatch/);
    client.put(name, good);
    client.failWith = 'Internal error';
    await assert.rejects(backup(), (e) => /object storage error/.test(e.message) && !/MISSING/.test(e.message));
    client.failWith = null;
    assert.deepEqual(fs.readdirSync(out), [], 'no partial backup directory is left');
  });

  const { backupDir, manifest } = await backup();
  assert.deepEqual(manifest.artifacts.map((a) => a.name), ['database.dump.enc', 'documents.archive.gz.enc', 'bank-imports.archive.gz.enc']);
  assert.equal(manifest.storage.backend, 'object');
  assert.equal(manifest.storage.environment_label, 'nonprod');
  assert.deepEqual(manifest.storage.referenced_files, { documents: 3, 'bank-imports': 1 });
  assert.equal(manifest.artifacts[1].files, 3, 'orphan object is not archived');
  assert.equal(manifest.artifacts[2].files, 1);
  assert.ok(client.calls.every(([op]) => op === 'download'), 'backup only downloads');
  for (const a of manifest.artifacts) {
    const raw = fs.readFileSync(path.join(backupDir, a.name));
    assert.ok(!raw.includes('Synthetic Co') && !raw.includes('synthetic document'), 'nothing readable at rest');
  }
  await core.verifyArtifacts(backupDir, PASS);

  const base = { backupDir, passphrase: PASS, restoreDatabaseUrl: dstUrl, restoreDocumentsDir: dstDocs, restoreBankDir: dstBank, productionDatabaseUrl: srcUrl, protectedDirs: [], confirmed: true };
  const callsBefore = client.calls.length;
  const { report } = await core.restoreBackup(base);

  await t.test('restore (isolated target, local directories) verifies files, checksums, records and accounting', () => {
    assert.equal(report.ok, true, JSON.stringify(report.failures));
    assert.equal(report.checks.documents.records, 3);
    assert.equal(report.checks.documents.verified, 3);
    assert.equal(report.checks.documents.orphan_files, 0);
    assert.equal(report.checks.bank_import_batches.verified, 1);
    assert.equal(report.checks.accounting.unbalanced_entries, 0);
    for (const f of seed.files) assert.deepEqual(fs.readFileSync(path.join(dstDocs, f.key)), f.data);
    assert.equal(client.calls.length, callsBefore, 'restore never touches Object Storage');
    console.log('OBJECT-ROUND-TRIP-EVIDENCE ' + JSON.stringify({ documents: report.checks.documents, bank: report.checks.bank_import_batches, accounting: report.checks.accounting, rows: report.checks.row_counts }));
  });

  await t.test('restore into the live database or live storage is still refused for an object backup', async () => {
    await assert.rejects(core.restoreBackup({ ...base, restoreDatabaseUrl: srcUrl }), /must match/);
    await assert.rejects(core.restoreBackup({ ...base, restoreDatabaseUrl: withDb(adminUrl, dstName), productionDatabaseUrl: dstUrl }), /same as the configured|not empty/);
  });

  await t.test('the CLI backup command for object mode is wired (bucket id required, no SDK/network used in tests)', () => {
    const r = spawnSync('node', [path.join(REPO, 'tools/backup/cli.js'), 'backup', '--out', path.join(work, 'cli-out')], { env: { PATH: process.env.PATH, DATABASE_URL: srcUrl, BACKUP_PASSPHRASE: PASS, STORAGE_BACKEND: 'object' }, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OBJECT_STORAGE_BUCKET_ID/);
    assert.equal(fs.existsSync(path.join(work, 'cli-out')), false);
  });
});
