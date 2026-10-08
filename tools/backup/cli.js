#!/usr/bin/env node
'use strict';
const path = require('path');
const lib = require('./lib');
const core = require('./core');

const USAGE = `EQFAL backup & restore (manual use only; nothing here schedules or uploads)

  node tools/backup/cli.js backup  --out <dir>
  node tools/backup/cli.js verify  --backup <dir>
  node tools/backup/cli.js restore --backup <dir> --i-confirm-isolated-test-target
  node tools/backup/cli.js prune   --root <dir> [--apply]

Environment:
  DATABASE_URL, DOCUMENT_STORAGE_DIR, BANK_STORAGE_DIR   source (backup)
  RESTORE_DATABASE_URL, RESTORE_DOCUMENT_DIR, RESTORE_BANK_DIR   isolated test target (restore)
  BACKUP_PASSPHRASE_FILE (chmod 600; preferred) or BACKUP_PASSPHRASE   >= 16 characters
`;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);
const log = (m) => console.error(`[backup] ${m}`);

async function main() {
  const cmd = process.argv[2];
  const env = process.env;
  if (cmd === 'backup') {
    const dirs = core.defaultStorageDirs(env);
    const out = arg('out') ?? env.BACKUP_OUTPUT_DIR;
    if (!out) throw new lib.BackupError('--out <dir> is required');
    const { backupDir } = await core.createBackup({ databaseUrl: env.DATABASE_URL, documentsDir: dirs.documents, bankDir: dirs.bank, outDir: out, passphrase: lib.readPassphrase(env), log });
    console.log(backupDir);
  } else if (cmd === 'verify') {
    const { manifest } = await core.verifyArtifacts(path.resolve(arg('backup') ?? ''), lib.readPassphrase(env), log);
    console.log(JSON.stringify({ ok: true, created_at: manifest.created_at, artifacts: manifest.artifacts.map((a) => a.name) }, null, 2));
  } else if (cmd === 'restore') {
    const dirs = core.defaultStorageDirs(env);
    const { report } = await core.restoreBackup({
      backupDir: path.resolve(arg('backup') ?? ''), passphrase: lib.readPassphrase(env),
      restoreDatabaseUrl: env.RESTORE_DATABASE_URL, restoreDocumentsDir: env.RESTORE_DOCUMENT_DIR, restoreBankDir: env.RESTORE_BANK_DIR,
      productionDatabaseUrl: env.DATABASE_URL, protectedDirs: [dirs.documents, dirs.bank],
      confirmed: flag('i-confirm-isolated-test-target'), log,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
  } else if (cmd === 'prune') {
    const res = core.pruneBackups(path.resolve(arg('root') ?? ''), { apply: flag('apply') });
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.error(USAGE);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  if (err.partialRestore) console.error('The restore stopped part-way. Drop the test database and empty the storage directories before retrying.');
  process.exitCode = 1;
});
