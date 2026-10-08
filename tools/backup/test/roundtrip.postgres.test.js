'use strict';
// Full backup -> isolated restore round trip on disposable databases with SYNTHETIC data only.
// Needs DATABASE_URL to a server where the user can CREATE DATABASE (CI service container / local scratch server).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../lib');
const core = require('../core');
const { mkTmp, PASS, hasPgTools, withDb, adminExec, seedSynthetic } = require('./helpers');

const adminUrl = process.env.DATABASE_URL;
const required = process.env.REQUIRE_POSTGRES_TESTS === 'true';
const skip = (!adminUrl || !hasPgTools()) && !required ? 'DATABASE_URL or pg_dump/pg_restore not available' : false;
const REPO = path.resolve(__dirname, '../../..');

test('backup/restore round trip (synthetic data)', { skip, timeout: 240000 }, async (t) => {
  assert.ok(adminUrl, 'DATABASE_URL is required when REQUIRE_POSTGRES_TESTS=true');
  const run = crypto.randomBytes(4).toString('hex');
  const srcName = `eqfal_bk_src_${run}`;
  const dstName = `eqfal_bk_restore_test_${run}`;
  const srcUrl = withDb(adminUrl, srcName);
  const dstUrl = withDb(adminUrl, dstName);
  const work = mkTmp();
  const srcDocs = path.join(work, 'src/documents');
  const srcBank = path.join(work, 'src/bank');
  const dstDocs = path.join(work, 'dst/documents');
  const dstBank = path.join(work, 'dst/bank');
  const out = path.join(work, 'backups');
  fs.mkdirSync(srcDocs, { recursive: true });
  fs.mkdirSync(srcBank, { recursive: true });

  await adminExec(adminUrl, `CREATE DATABASE ${srcName}`);
  await adminExec(adminUrl, `CREATE DATABASE ${dstName}`);
  t.after(async () => {
    await adminExec(adminUrl, `DROP DATABASE IF EXISTS ${srcName} WITH (FORCE)`);
    await adminExec(adminUrl, `DROP DATABASE IF EXISTS ${dstName} WITH (FORCE)`);
    fs.rmSync(work, { recursive: true, force: true });
  });

  const mig = spawnSync('npx', ['tsx', 'server/src/db/migrate-cli.ts'], { cwd: REPO, env: { ...process.env, DATABASE_URL: srcUrl }, encoding: 'utf8' });
  assert.equal(mig.status, 0, mig.stderr);
  const seed = await seedSynthetic(srcUrl, srcDocs, srcBank);

  const { backupDir, manifest } = await core.createBackup({ databaseUrl: srcUrl, documentsDir: srcDocs, bankDir: srcBank, outDir: out, passphrase: PASS });
  assert.deepEqual(manifest.artifacts.map((a) => a.name), ['database.dump.enc', 'documents.tar.gz.enc', 'bank-imports.tar.gz.enc']);
  assert.equal(manifest.artifacts[1].files_at_scan, 3);
  assert.equal(manifest.consistency.strategy, 'database-snapshot-then-files');
  assert.ok(manifest.source.migration_count >= 61);
  assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
  // nothing readable in the artifacts
  for (const a of manifest.artifacts) {
    const raw = fs.readFileSync(path.join(backupDir, a.name));
    assert.ok(!raw.includes('Synthetic Co') && !raw.includes('synthetic document'));
  }
  await core.verifyArtifacts(backupDir, PASS);

  const base = { backupDir, passphrase: PASS, restoreDatabaseUrl: dstUrl, restoreDocumentsDir: dstDocs, restoreBankDir: dstBank, productionDatabaseUrl: srcUrl, protectedDirs: [srcDocs, srcBank], confirmed: true };

  await t.test('refuses unsafe targets', async () => {
    await assert.rejects(core.restoreBackup({ ...base, confirmed: false }), /i-confirm-isolated/);
    await assert.rejects(core.restoreBackup({ ...base, restoreDatabaseUrl: srcUrl }), /must contain restore|same as DATABASE_URL|not empty/);
    await assert.rejects(core.restoreBackup({ ...base, restoreDatabaseUrl: withDb(adminUrl, 'postgres') }), /must contain restore/);
    await assert.rejects(core.restoreBackup({ ...base, restoreDatabaseUrl: dstUrl.replace(/@[^/]+\//, '@db.example.com:5432/') }), /not local/);
    await assert.rejects(core.restoreBackup({ ...base, restoreDocumentsDir: srcDocs }), /overlaps a live storage|not empty/);
    await assert.rejects(core.restoreBackup({ ...base, restoreDocumentsDir: path.join(srcDocs, 'sub') }), /overlaps a live storage/);
    await assert.rejects(core.restoreBackup({ ...base, restoreBankDir: path.join(dstDocs, 'nested') }), /non-nested/);
    await assert.rejects(core.restoreBackup({ ...base, restoreDocumentsDir: 'relative/dir' }), /absolute/);
    fs.mkdirSync(path.join(work, 'dirty'));
    fs.writeFileSync(path.join(work, 'dirty/x'), '1');
    await assert.rejects(core.restoreBackup({ ...base, restoreBankDir: path.join(work, 'dirty') }), /not empty/);
    await assert.rejects(core.restoreBackup({ ...base, passphrase: PASS + 'x' }), /authentication failed/);
    assert.equal(fs.existsSync(dstDocs), false, 'nothing created by refused attempts');
  });

  await t.test('detects tampered artifact before touching the target', async () => {
    const copy = path.join(work, 'tampered');
    fs.cpSync(backupDir, copy, { recursive: true });
    const f = path.join(copy, 'documents.tar.gz.enc');
    const b = fs.readFileSync(f); b[b.length - 100] ^= 1; fs.writeFileSync(f, b);
    await assert.rejects(core.restoreBackup({ ...base, backupDir: copy }), /Checksum mismatch/);
    const { Client } = require('pg');
    const c = new Client({ connectionString: dstUrl });
    await c.connect();
    const n = (await c.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`)).rows[0].n;
    await c.end();
    assert.equal(n, 0, 'target DB still empty');
  });

  const { report } = await core.restoreBackup(base);
  await t.test('restore verifies files, checksums, records and accounting', () => {
    assert.equal(report.ok, true, JSON.stringify(report.failures));
    assert.equal(report.checks.documents.records, 3);
    assert.equal(report.checks.documents.verified, 3);
    assert.equal(report.checks.bank_import_batches.verified, 1);
    assert.equal(report.checks.accounting.unbalanced_entries, 0);
    assert.equal(report.checks.accounting.companies_with_posted_entries, 1);
    assert.equal(report.checks.row_counts.journal_lines, 4);
    for (const f of seed.files) assert.deepEqual(fs.readFileSync(path.join(dstDocs, f.key)), f.data);
    assert.ok(fs.existsSync(path.join(dstBank, seed.bankKey)));
    console.log('ROUND-TRIP-EVIDENCE ' + JSON.stringify({ migrations: report.checks.migrations, documents: report.checks.documents, bank: report.checks.bank_import_batches, accounting: report.checks.accounting, rows: report.checks.row_counts }));
  });

  await t.test('second restore into the now-populated target is refused', async () => {
    await assert.rejects(core.restoreBackup({ ...base, restoreDocumentsDir: path.join(work, 'dst2/d'), restoreBankDir: path.join(work, 'dst2/b') }), /not empty/);
  });

  await t.test('verifier catches a missing file, a corrupted file and an unbalanced entry', async () => {
    const v = () => core.verifyRestored({ restoreDatabaseUrl: dstUrl, restoreDocumentsDir: dstDocs, restoreBankDir: dstBank, manifest });
    const victim = path.join(dstDocs, seed.files[0].key);
    const original = fs.readFileSync(victim);
    fs.writeFileSync(victim, 'corrupted');
    let r = await v();
    assert.equal(r.ok, false);
    assert.match(r.failures.join('\n'), /sha256 mismatch/);
    fs.rmSync(victim);
    r = await v();
    assert.match(r.failures.join('\n'), /file missing/);
    fs.writeFileSync(victim, original);
    assert.equal((await v()).ok, true);
    // Unbalance a posted entry directly (trigger blocks updates, so drop it only inside this disposable DB).
    const { Client } = require('pg');
    const c = new Client({ connectionString: dstUrl });
    await c.connect();
    await c.query('ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_posted_immutable');
    await c.query(`UPDATE journal_lines SET debit = debit + 1 WHERE id = (SELECT id FROM journal_lines WHERE sequence=1 LIMIT 1)`);
    await c.end();
    r = await v();
    assert.equal(r.ok, false);
    assert.match(r.failures.join('\n'), /unbalanced|does not balance/);
  });
});
