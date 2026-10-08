'use strict';
const lib = require('./lib');
const { BackupError, fs, path } = lib;
const { pipeline } = require('stream/promises');

const TOOL_VERSION = 1;
const SAFE_DB_NAME_RE = /(restore|test|scratch|drill)/i;
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

function defaultStorageDirs(env = process.env) {
  return {
    documents: path.resolve(env.DOCUMENT_STORAGE_DIR ?? path.resolve(process.cwd(), '.data/documents')),
    bank: path.resolve(env.BANK_STORAGE_DIR ?? path.resolve(process.cwd(), '.data/bank-imports')),
  };
}

function loadPg() {
  // `pg` is a server workspace dependency (hoisted to the root node_modules).
  return require('pg');
}

async function queryOne(url, sql) {
  const { Client } = loadPg();
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(sql)).rows; } finally { await c.end(); }
}

// ---------------- backup ----------------
async function createBackup({ databaseUrl, documentsDir, bankDir, outDir, passphrase, now = new Date(), log = () => {} }) {
  if (!databaseUrl) throw new BackupError('DATABASE_URL (source) is required');
  const docs = path.resolve(documentsDir);
  const bank = path.resolve(bankDir);
  const out = path.resolve(outDir);
  for (const dir of [docs, bank]) {
    if (lib.isInside(lib.nearestExisting(out), dir)) throw new BackupError('Backup output directory must not be inside a storage directory');
  }
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const backupDir = path.join(out, `eqfal-backup-${lib.utcStamp(now)}`);
  fs.mkdirSync(backupDir, { mode: 0o700 }); // fails if it already exists
  const artifacts = [];
  const warnings = [];

  try {
    const meta = (await queryOne(databaseUrl,
      `SELECT current_database() AS db, current_setting('server_version') AS pg_version,
              (SELECT count(*)::int FROM _schema_migrations) AS migration_count,
              (SELECT max(filename) FROM _schema_migrations) AS last_migration`))[0];

    // Consistency strategy: (1) database snapshot first, (2) storage archives afterwards.
    // Files are write-once and written BEFORE their DB row is committed, so every row visible in
    // the snapshot has its file on disk when the archives are taken. Files newer than the snapshot
    // are harmless orphans. See docs/BACKUP_RESTORE.md.
    const dumpStartedAt = new Date().toISOString();
    log('pg_dump (custom format) ...');
    const dump = lib.spawnProc('pg_dump', ['-Fc', '--no-owner', '--no-acl'], { env: lib.pgEnv(databaseUrl) });
    const dumpEnc = await lib.encryptStream(dump.child.stdout, path.join(backupDir, 'database.dump.enc'), passphrase);
    const dumpRes = await dump.done;
    if (dumpRes.code !== 0) throw new BackupError(`pg_dump failed (exit ${dumpRes.code}): ${dumpRes.stderr.trim().slice(0, 500)}`);
    const dumpFinishedAt = new Date().toISOString();
    artifacts.push({ name: 'database.dump.enc', kind: 'postgres-custom-dump', ...dumpEnc });

    const filesScannedAt = new Date().toISOString();
    for (const [name, dir, kind] of [['documents.tar.gz.enc', docs, 'documents-tar-gz'], ['bank-imports.tar.gz.enc', bank, 'bank-imports-tar-gz']]) {
      const scan = lib.walkFiles(dir);
      log(`archiving ${kind} (${scan.length} files) ...`);
      const tar = lib.tarCreateStream(dir);
      const enc = await lib.encryptStream(tar.stream, path.join(backupDir, name), passphrase);
      const res = await tar.done;
      if (res.code === 1) warnings.push(`${name}: tar reported "file changed as we read it" (a file was being written); expected orphan only`);
      else if (res.code !== 0) throw new BackupError(`tar failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`);
      artifacts.push({ name, kind, ...enc, files_at_scan: scan.length, bytes_at_scan: scan.reduce((s, f) => s + f.size, 0) });
    }

    const manifest = lib.sealManifest({
      format: 1,
      tool_version: TOOL_VERSION,
      created_at: now.toISOString(),
      source: { database: meta.db, postgres_version: meta.pg_version, migration_count: meta.migration_count, last_migration: meta.last_migration },
      consistency: { strategy: 'database-snapshot-then-files', dump_started_at: dumpStartedAt, dump_finished_at: dumpFinishedAt, files_scanned_at: filesScannedAt },
      encryption: { algorithm: 'aes-256-gcm', kdf: lib.KDF.name, kdf_params: { N: lib.KDF.N, r: lib.KDF.r, p: lib.KDF.p } },
      artifacts,
      warnings,
    }, passphrase);
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    log(`backup complete: ${backupDir}`);
    return { backupDir, manifest };
  } catch (err) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    throw err;
  }
}

// ---------------- verify artifacts (no target needed) ----------------
async function drain(stream) { for await (const _ of stream) { /* consume to completion; auth tag is checked at end */ } }

async function verifyArtifacts(backupDir, passphrase, log = () => {}) {
  const manifest = lib.readAndVerifyManifest(backupDir, passphrase);
  const results = [];
  for (const a of manifest.artifacts) {
    const file = path.join(backupDir, a.name);
    if (!fs.existsSync(file)) throw new BackupError(`Artifact missing: ${a.name}`);
    const encSha = await lib.sha256File(file);
    if (encSha !== a.encrypted_sha256) throw new BackupError(`Checksum mismatch for ${a.name}`);
    const plain = lib.decryptStream(file, passphrase);
    await drain(plain);
    const res = plain.plainResult();
    if (res.plain_sha256 !== a.plain_sha256) throw new BackupError(`Plaintext checksum mismatch for ${a.name}`);
    if (a.kind.endsWith('tar-gz')) {
      await lib.listAndCheckTar(lib.decryptStream(file, passphrase)); // rejects links/devices/traversal
    }
    log(`ok ${a.name}`);
    results.push({ name: a.name, ok: true });
  }
  return { manifest, results };
}

// ---------------- restore safety ----------------
async function assertSafeRestoreTarget({ restoreDatabaseUrl, restoreDocumentsDir, restoreBankDir, productionDatabaseUrl, protectedDirs = [], backupDir }) {
  if (!restoreDatabaseUrl) throw new BackupError('RESTORE_DATABASE_URL is required');
  const target = lib.parseDbUrl(restoreDatabaseUrl);
  if (!SAFE_DB_NAME_RE.test(target.database)) {
    throw new BackupError(`Target database name "${target.database}" must contain restore, test, scratch or drill`);
  }
  if (!LOCAL_HOSTS.has(target.host) && !target.host.startsWith('/')) {
    throw new BackupError(`Target host "${target.host}" is not local; restore tests run only on localhost or a unix socket`);
  }
  if (productionDatabaseUrl) {
    const prod = lib.parseDbUrl(productionDatabaseUrl);
    const norm = (h) => (LOCAL_HOSTS.has(h) ? 'local' : h);
    if (norm(prod.host) === norm(target.host) && prod.port === target.port && prod.database === target.database) {
      throw new BackupError('Target database is the same as DATABASE_URL; refusing');
    }
  }

  const dirs = { documents: restoreDocumentsDir, bank: restoreBankDir };
  const resolved = {};
  for (const [label, dir] of Object.entries(dirs)) {
    if (!dir) throw new BackupError(`Restore ${label} directory is required`);
    if (!path.isAbsolute(dir)) throw new BackupError(`Restore ${label} directory must be an absolute path`);
    if (fs.existsSync(dir)) {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new BackupError(`Restore ${label} directory must not be a symlink`);
      if (!fs.statSync(dir).isDirectory()) throw new BackupError(`Restore ${label} path is not a directory`);
      if (fs.readdirSync(dir).length > 0) throw new BackupError(`Restore ${label} directory is not empty: ${dir}`);
    }
    resolved[label] = lib.nearestExisting(dir);
  }
  if (lib.isInside(resolved.documents, resolved.bank) || lib.isInside(resolved.bank, resolved.documents)) {
    throw new BackupError('Restore documents and bank directories must be separate, non-nested');
  }
  for (const [label, dir] of Object.entries(resolved)) {
    for (const prot of protectedDirs.filter(Boolean)) {
      const p = lib.nearestExisting(prot);
      if (lib.isInside(dir, p) || lib.isInside(p, dir)) throw new BackupError(`Restore ${label} directory overlaps a live storage directory (${prot})`);
    }
    if (backupDir && (lib.isInside(dir, lib.nearestExisting(backupDir)) || lib.isInside(lib.nearestExisting(backupDir), dir))) {
      throw new BackupError(`Restore ${label} directory overlaps the backup directory`);
    }
  }

  const rows = await queryOne(restoreDatabaseUrl,
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND c.relkind IN ('r','v','m','S','f','p')`);
  if (rows[0].n > 0) throw new BackupError(`Target database is not empty (${rows[0].n} relations); refusing`);
  return true;
}

// ---------------- verify restored state ----------------
async function verifyRestored({ restoreDatabaseUrl, restoreDocumentsDir, restoreBankDir, manifest }) {
  const { Client } = loadPg();
  const c = new Client({ connectionString: restoreDatabaseUrl });
  await c.connect();
  const failures = [];
  const report = { checks: {}, failures };
  try {
    const mig = (await c.query(`SELECT count(*)::int AS n, max(filename) AS last FROM _schema_migrations`)).rows[0];
    report.checks.migrations = { restored: mig.n, last: mig.last };
    if (manifest && (mig.n !== manifest.source.migration_count || mig.last !== manifest.source.last_migration)) {
      failures.push(`migration mismatch: restored ${mig.n}/${mig.last}, backup ${manifest.source.migration_count}/${manifest.source.last_migration}`);
    }

    const crypto = require('crypto');
    const checkFiles = async (label, dir, rows, getKey, getSha, getSize) => {
      let ok = 0;
      const referenced = new Set();
      for (const r of rows) {
        const key = getKey(r);
        referenced.add(key);
        const file = path.join(dir, key);
        if (!lib.isInside(path.resolve(file), path.resolve(dir)) || !fs.existsSync(file)) { failures.push(`${label}: file missing for storage_key ${key}`); continue; }
        const data = fs.readFileSync(file);
        if (crypto.createHash('sha256').update(data).digest('hex') !== getSha(r)) { failures.push(`${label}: sha256 mismatch for ${key}`); continue; }
        if (getSize && data.length !== getSize(r)) { failures.push(`${label}: size mismatch for ${key}`); continue; }
        ok++;
      }
      const orphans = lib.walkFiles(dir).filter((f) => !referenced.has(f.key)).length;
      report.checks[label] = { records: rows.length, verified: ok, orphan_files: orphans };
    };
    const docs = (await c.query(`SELECT storage_key, sha256, size_bytes FROM documents`)).rows;
    await checkFiles('documents', restoreDocumentsDir, docs, (r) => r.storage_key, (r) => r.sha256, (r) => r.size_bytes);
    const batches = (await c.query(`SELECT storage_key, file_sha256 FROM bank_import_batches`)).rows;
    await checkFiles('bank_import_batches', restoreBankDir, batches, (r) => r.storage_key, (r) => r.file_sha256);

    // Read-only accounting integrity checks (no business logic is reimplemented).
    const unbalanced = (await c.query(
      `SELECT je.company_id, je.id FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id AND jl.company_id=je.company_id
        WHERE je.status='posted' GROUP BY je.company_id, je.id HAVING SUM(jl.debit) <> SUM(jl.credit)`)).rows;
    if (unbalanced.length) failures.push(`${unbalanced.length} posted journal entries are unbalanced`);
    const tb = (await c.query(
      `SELECT je.company_id, SUM(jl.debit)::text AS debit, SUM(jl.credit)::text AS credit
         FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id AND jl.company_id=je.company_id
        WHERE je.status='posted' GROUP BY je.company_id ORDER BY je.company_id`)).rows;
    for (const r of tb) if (r.debit !== r.credit) failures.push(`trial balance does not balance for company ${r.company_id}`);
    const noLines = (await c.query(`SELECT count(*)::int AS n FROM journal_entries je WHERE je.status='posted'
        AND NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.journal_entry_id=je.id)`)).rows[0].n;
    if (noLines) failures.push(`${noLines} posted journal entries have no lines`);
    const counts = {};
    for (const t of ['companies', 'users', 'accounts', 'journal_entries', 'journal_lines', 'documents', 'bank_import_batches']) {
      counts[t] = (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    }
    report.checks.accounting = { companies_with_posted_entries: tb.length, unbalanced_entries: unbalanced.length, posted_entries_without_lines: noLines };
    report.checks.row_counts = counts;
  } finally {
    await c.end();
  }
  report.ok = failures.length === 0;
  return report;
}

// ---------------- restore ----------------
async function restoreBackup({ backupDir, passphrase, restoreDatabaseUrl, restoreDocumentsDir, restoreBankDir, productionDatabaseUrl, protectedDirs, confirmed, log = () => {} }) {
  if (!confirmed) throw new BackupError('Refusing to restore without --i-confirm-isolated-test-target');
  log('verifying backup artifacts ...');
  const { manifest } = await verifyArtifacts(backupDir, passphrase, log);
  await assertSafeRestoreTarget({ restoreDatabaseUrl, restoreDocumentsDir, restoreBankDir, productionDatabaseUrl, protectedDirs, backupDir });

  const createdDirs = [];
  try {
    for (const d of [restoreDocumentsDir, restoreBankDir]) {
      if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); createdDirs.push(d); }
    }
    log('pg_restore (single transaction) ...');
    const dumpFile = path.join(backupDir, 'database.dump.enc');
    const pr = lib.spawnProc('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '-d', lib.parseDbUrl(restoreDatabaseUrl).database],
      { env: lib.pgEnv(restoreDatabaseUrl), stdin: 'pipe' });
    pr.child.stdout.resume();
    pr.child.stdin.on('error', () => {});
    await pipeline(lib.decryptStream(dumpFile, passphrase), pr.child.stdin).catch(() => {});
    const prRes = await pr.done;
    if (prRes.code !== 0) throw new BackupError(`pg_restore failed (exit ${prRes.code}): ${prRes.stderr.trim().slice(0, 500)}`);

    log('extracting storage archives ...');
    await lib.extractTar(lib.decryptStream(path.join(backupDir, 'documents.tar.gz.enc'), passphrase), restoreDocumentsDir);
    await lib.extractTar(lib.decryptStream(path.join(backupDir, 'bank-imports.tar.gz.enc'), passphrase), restoreBankDir);

    log('verifying restored data ...');
    const report = await verifyRestored({ restoreDatabaseUrl, restoreDocumentsDir, restoreBankDir, manifest });
    return { manifest, report };
  } catch (err) {
    err.partialRestore = true;
    throw err;
  }
}

// ---------------- prune (manual retention) ----------------
function pruneBackups(root, { apply = false, policy } = {}) {
  const names = fs.readdirSync(root).filter((n) => lib.parseBackupDirName(n) && fs.existsSync(path.join(root, n, 'manifest.json')));
  const plan = lib.planRetention(names, policy);
  if (apply) for (const n of plan.remove) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  return { ...plan, applied: apply };
}

module.exports = { createBackup, verifyArtifacts, assertSafeRestoreTarget, verifyRestored, restoreBackup, pruneBackups, defaultStorageDirs, SAFE_DB_NAME_RE };
