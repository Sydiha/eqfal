'use strict';
const lib = require('./lib');
const archive = require('./archive');
const objectstore = require('./objectstore');
const { BackupError, fs, path } = lib;

const TOOL_VERSION = 2;
const ARCHIVE_ATTEMPTS = 3;
// A restore target must be created on purpose: right name AND an explicit marker comment on the database.
const TARGET_NAME_RE = /^eqfal_restore_[a-z0-9_]{1,40}$/;
const TARGET_MARKER = 'EQFAL_DISPOSABLE_RESTORE_TARGET';
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);
const ARCHIVES = [
  { name: 'documents.archive.gz.enc', kind: 'documents-archive', dirKey: 'documents' },
  { name: 'bank-imports.archive.gz.enc', kind: 'bank-imports-archive', dirKey: 'bank' },
];

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

async function queryRows(url, sql) {
  const { Client } = loadPg();
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(sql)).rows; } finally { await c.end(); }
}

// ---------------- backup ----------------
const META_SQL = `SELECT current_database() AS db, current_setting('server_version') AS pg_version,
              (SELECT count(*)::int FROM _schema_migrations) AS migration_count,
              (SELECT max(filename) FROM _schema_migrations) AS last_migration`;
const OBJECT_ARCHIVES = [
  { ...ARCHIVES[0], objectKind: 'documents', refSql: `SELECT storage_key AS key, sha256, size_bytes::text AS size FROM documents` },
  { ...ARCHIVES[1], objectKind: 'bank-imports', refSql: `SELECT storage_key AS key, file_sha256 AS sha256 FROM bank_import_batches` },
];

// Object Storage mode: pg_dump and the list of referenced files come from ONE exported snapshot, so every file the
// restored database references is exactly the set we archive (later uploads/deletes cannot desynchronise them).
async function dumpWithSnapshot({ databaseUrl, backupDir, passphrase, log }) {
  const { Client } = loadPg();
  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await c.query('SELECT pg_export_snapshot() AS s')).rows[0].s;
    const meta = (await c.query(META_SQL)).rows[0];
    const refs = {};
    for (const a of OBJECT_ARCHIVES) {
      refs[a.objectKind] = (await c.query(a.refSql)).rows.map((r) => ({ key: r.key, sha256: r.sha256, size: r.size === undefined ? undefined : Number(r.size) }));
    }
    const startedAt = new Date().toISOString();
    log('pg_dump (custom format, exported snapshot) ...');
    const dump = lib.spawnProc('pg_dump', ['-Fc', '--no-owner', '--no-acl', `--snapshot=${snapshot}`], { env: lib.pgEnv(databaseUrl) });
    const dumpEnc = await lib.encryptStream(dump.child.stdout, path.join(backupDir, 'database.dump.enc'), passphrase);
    const res = await dump.done;
    if (res.code !== 0) throw new BackupError(`pg_dump failed (exit ${res.code}): ${res.stderr.trim().slice(0, 500)}`);
    await c.query('COMMIT');
    return { meta, refs, dumpEnc, startedAt, finishedAt: new Date().toISOString() };
  } finally {
    await c.end().catch(() => {});
  }
}

async function createBackup({ databaseUrl, documentsDir, bankDir, outDir, passphrase, now = new Date(), log = () => {}, hooks = {}, objectStorage = null }) {
  if (!databaseUrl) throw new BackupError('DATABASE_URL (source) is required');
  const useObjects = Boolean(objectStorage);
  const dirs = useObjects ? {} : { documents: path.resolve(documentsDir), bank: path.resolve(bankDir) };
  const out = path.resolve(outDir);
  for (const dir of Object.values(dirs)) {
    if (lib.isInside(lib.nearestExisting(out), dir)) throw new BackupError('Backup output directory must not be inside a storage directory');
  }
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const backupDir = path.join(out, `eqfal-backup-${lib.utcStamp(now)}`);
  fs.mkdirSync(backupDir, { mode: 0o700 }); // fails if it already exists
  const artifacts = [];

  try {
    let meta;
    let dumpStartedAt;
    let dumpFinishedAt;
    let refs = null;
    if (useObjects) {
      const snap = await dumpWithSnapshot({ databaseUrl, backupDir, passphrase, log });
      ({ meta, refs } = snap);
      dumpStartedAt = snap.startedAt; dumpFinishedAt = snap.finishedAt;
      artifacts.push({ name: 'database.dump.enc', kind: 'postgres-custom-dump', ...snap.dumpEnc });
    } else {
      meta = (await queryRows(databaseUrl, META_SQL))[0];
      // Consistency strategy: (1) database snapshot first, (2) storage archives afterwards.
      // Files are write-once and written BEFORE their DB row is committed, so every row visible in the snapshot
      // has its file on disk when the archives are taken. Files newer than the snapshot are harmless orphans.
      dumpStartedAt = new Date().toISOString();
      log('pg_dump (custom format) ...');
      const dump = lib.spawnProc('pg_dump', ['-Fc', '--no-owner', '--no-acl'], { env: lib.pgEnv(databaseUrl) });
      const dumpEnc = await lib.encryptStream(dump.child.stdout, path.join(backupDir, 'database.dump.enc'), passphrase);
      const dumpRes = await dump.done;
      if (dumpRes.code !== 0) throw new BackupError(`pg_dump failed (exit ${dumpRes.code}): ${dumpRes.stderr.trim().slice(0, 500)}`);
      dumpFinishedAt = new Date().toISOString();
      artifacts.push({ name: 'database.dump.enc', kind: 'postgres-custom-dump', ...dumpEnc });
    }

    const filesScannedAt = new Date().toISOString();
    const storage = { backend: 'local' };
    if (useObjects) {
      // Same archive format and artifact names as a local backup, so verify/restore (and old tooling) work unchanged.
      // Every referenced object is downloaded, checked against the database SHA-256 (and size) and streamed straight
      // into the encrypted archive (no plaintext on disk). Any missing/mismatching object aborts the whole backup.
      const env = objectStorage.env ?? process.env;
      storage.backend = 'object';
      storage.environment_label = objectstore.environmentLabel(env);
      storage.referenced_files = {};
      for (const a of OBJECT_ARCHIVES) {
        const prefix = objectstore.prefixFor(a.objectKind, env);
        const items = objectstore.itemsFor(objectStorage.client, prefix, refs[a.objectKind], a.objectKind);
        log(`archiving ${items.length} ${a.kind} object(s) from Object Storage ...`);
        const result = await archive.writeItemsArchive(items, path.join(backupDir, a.name), (src, d) => lib.encryptStream(src, d, passphrase));
        if (result.files !== items.length) throw new BackupError(`${a.kind}: archived ${result.files} of ${items.length} referenced objects`);
        result.attempts = 1;
        artifacts.push({ name: a.name, kind: a.kind, ...result });
        storage.referenced_files[a.objectKind] = items.length;
      }
    }
    for (const a of useObjects ? [] : ARCHIVES) {
      const dest = path.join(backupDir, a.name);
      let result;
      for (let attempt = 1; ; attempt++) {
        log(`archiving ${a.kind} (attempt ${attempt}) ...`);
        try {
          result = await archive.writeArchive(dirs[a.dirKey], dest, (src, d) => lib.encryptStream(src, d, passphrase), { hooks: hooks[a.dirKey] ?? {} });
          result.attempts = attempt;
          break;
        } catch (err) {
          // A file changed/disappeared while being read: never certify that archive. Retry the archive step
          // only (the database snapshot was already taken, so the consistency order is preserved).
          if (!(err instanceof archive.ConcurrentChangeError) || attempt >= ARCHIVE_ATTEMPTS) {
            throw err instanceof archive.ConcurrentChangeError
              ? new BackupError(`Storage changed while archiving ${a.kind} (${attempt} attempts): ${err.message}. Re-run during a quiet period; no backup was certified.`)
              : err;
          }
          log(`  ${err.message}; retrying`);
        }
      }
      artifacts.push({ name: a.name, kind: a.kind, ...result });
    }

    const manifest = lib.sealManifest({
      format: 2,
      tool_version: TOOL_VERSION,
      created_at: now.toISOString(),
      source: { database: meta.db, postgres_version: meta.pg_version, migration_count: meta.migration_count, last_migration: meta.last_migration },
      // Additive field (old backups have none = local). Does not change the archive format.
      storage,
      consistency: { strategy: useObjects ? 'database-snapshot-with-referenced-objects' : 'database-snapshot-then-files', dump_started_at: dumpStartedAt, dump_finished_at: dumpFinishedAt, files_scanned_at: filesScannedAt },
      encryption: { algorithm: 'aes-256-gcm', kdf: lib.KDF.name, kdf_params: { N: lib.KDF.N, r: lib.KDF.r, p: lib.KDF.p } },
      verification_status: 'not-verified: backup created only; run verify and an isolated restore test',
      artifacts,
    }, passphrase);
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    log(`backup created: ${backupDir}`);
    return { backupDir, manifest };
  } catch (err) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    throw err;
  }
}

// ---------------- artifact verification (cryptographic / structural ONLY) ----------------
// Proves: manifest authentic, every artifact has the recorded checksums, decrypts and authenticates, and each
// storage archive parses with only safe entries. It does NOT prove the database restores.
async function drain(stream) { for await (const _ of stream) { /* consume to the end so the auth tag is checked */ } }

async function verifyArtifacts(backupDir, passphrase, log = () => {}) {
  const manifest = lib.readAndVerifyManifest(backupDir, passphrase);
  if (manifest.format !== 2) throw new BackupError(`Unsupported backup format ${manifest.format}`);
  for (const a of manifest.artifacts) {
    const file = path.join(backupDir, a.name);
    if (!fs.existsSync(file)) throw new BackupError(`Artifact missing: ${a.name}`);
    if (await lib.sha256File(file) !== a.encrypted_sha256) throw new BackupError(`Checksum mismatch for ${a.name}`);
    const plain = lib.decryptStream(file, passphrase);
    if (a.kind.endsWith('-archive')) {
      const entries = await archive.readArchive(plain, null);
      await drain(plain).catch(() => {});
      if (entries.length !== a.files) throw new BackupError(`Archive entry count mismatch for ${a.name}`);
    } else {
      await drain(plain);
    }
    const res = plain.plainResult();
    if (res.plain_sha256 !== a.plain_sha256) throw new BackupError(`Plaintext checksum mismatch for ${a.name}`);
    log(`artifact integrity ok: ${a.name}`);
  }
  return { manifest };
}

// ---------------- restore target safety ----------------
async function serverIdentity(url) {
  const r = (await queryRows(url,
    `SELECT pg_postmaster_start_time()::text AS started, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS datoid,
            current_database() AS db,
            (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) AS marker`))[0];
  return { id: `${r.started}|${r.datoid}`, db: r.db, marker: r.marker };
}

// True when both URLs reach the same database of the same server instance, however the host is spelled.
async function sameServerDatabase(urlA, urlB) {
  return (await serverIdentity(urlA)).id === (await serverIdentity(urlB)).id;
}

function productionCandidates(env, extra) {
  const urls = new Set([extra, env.DATABASE_URL].filter(Boolean));
  if (env.PGDATABASE) {
    const host = env.PGHOST || 'localhost';
    urls.add(`postgresql://${encodeURIComponent(env.PGUSER ?? '')}:${encodeURIComponent(env.PGPASSWORD ?? '')}@${host}:${env.PGPORT || 5432}/${env.PGDATABASE}`);
  }
  return [...urls];
}

async function assertSafeRestoreTarget({ restoreDatabaseUrl, restoreDocumentsDir, restoreBankDir, productionDatabaseUrl, protectedDirs = [], backupDir, env = process.env }) {
  if (!restoreDatabaseUrl) throw new BackupError('RESTORE_DATABASE_URL is required');
  const target = lib.parseDbUrl(restoreDatabaseUrl);
  if (!TARGET_NAME_RE.test(target.database)) {
    throw new BackupError(`Target database name "${target.database}" must match ${TARGET_NAME_RE} (create a dedicated database for restore tests)`);
  }
  if (!LOCAL_HOSTS.has(target.host) && !target.host.startsWith('/')) {
    throw new BackupError(`Target host "${target.host}" is not local; restore tests run only on localhost or a unix socket`);
  }

  // Cheap textual comparison first, then the real identity check against the server itself.
  const norm = (h) => (LOCAL_HOSTS.has(h) ? 'local' : h);
  const candidates = productionCandidates(env, productionDatabaseUrl);
  for (const cand of candidates) {
    const prod = lib.parseDbUrl(cand);
    if (norm(prod.host) === norm(target.host) && prod.port === target.port && prod.database === target.database) {
      throw new BackupError('Target database is the same as the configured application database; refusing');
    }
  }

  const me = await serverIdentity(restoreDatabaseUrl); // also proves the target is reachable
  if (me.marker !== TARGET_MARKER) {
    throw new BackupError(`Target database is not marked as a disposable restore target. Create it on purpose with: COMMENT ON DATABASE ${target.database} IS '${TARGET_MARKER}';`);
  }
  for (const cand of candidates) {
    let other;
    try { other = await serverIdentity(cand); } catch { continue; } // unreachable candidate cannot be the same live DB we just reached
    if (other.id === me.id) throw new BackupError('Target resolves to the same server database as the configured application database (alias); refusing');
  }

  const resolved = {};
  for (const [label, dir] of [['documents', restoreDocumentsDir], ['bank', restoreBankDir]]) {
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

  const rows = await queryRows(restoreDatabaseUrl,
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND c.relkind IN ('r','v','m','S','f','p')`);
  if (rows[0].n > 0) throw new BackupError(`Target database is not empty (${rows[0].n} relations); refusing`);
  return true;
}

// ---------------- verify restored state ----------------
async function verifyRestored({ restoreDatabaseUrl, restoreDocumentsDir, restoreBankDir, manifest }) {
  const { Client } = loadPg();
  const crypto = require('crypto');
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

    const checkFiles = (label, dir, rows, getKey, getSha, getSize) => {
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
      report.checks[label] = { records: rows.length, verified: ok, orphan_files: lib.walkFiles(dir).filter((f) => !referenced.has(f.key)).length };
    };
    checkFiles('documents', restoreDocumentsDir, (await c.query(`SELECT storage_key, sha256, size_bytes FROM documents`)).rows, (r) => r.storage_key, (r) => r.sha256, (r) => r.size_bytes);
    checkFiles('bank_import_batches', restoreBankDir, (await c.query(`SELECT storage_key, file_sha256 FROM bank_import_batches`)).rows, (r) => r.storage_key, (r) => r.file_sha256);

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
async function restoreBackup({ backupDir, passphrase, restoreDatabaseUrl, restoreDocumentsDir, restoreBankDir, productionDatabaseUrl, protectedDirs, confirmed, env = process.env, log = () => {} }) {
  if (!confirmed) throw new BackupError('Refusing to restore without --i-confirm-isolated-test-target');
  log('checking backup artifacts (integrity only) ...');
  const { manifest } = await verifyArtifacts(backupDir, passphrase, log);
  await assertSafeRestoreTarget({ restoreDatabaseUrl, restoreDocumentsDir, restoreBankDir, productionDatabaseUrl, protectedDirs, backupDir, env });

  // Every artifact is first decrypted+authenticated into ONE private copy; all later steps read only that copy,
  // so nothing can change between validation and use, and a late authentication failure can never be ignored.
  const tmp = fs.mkdtempSync(path.join(env.RESTORE_TMP_DIR || require('os').tmpdir(), 'eqfal-restore-')); // mode 0700
  try {
    const priv = {};
    for (const a of manifest.artifacts) {
      priv[a.name] = path.join(tmp, a.name.replace(/\.enc$/, ''));
      const res = await lib.decryptToFile(path.join(backupDir, a.name), priv[a.name], passphrase);
      if (res.plain_sha256 !== a.plain_sha256) throw new BackupError(`Plaintext checksum mismatch for ${a.name}`);
    }

    for (const d of [restoreDocumentsDir, restoreBankDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

    log('pg_restore (single transaction) ...');
    await lib.runToCompletion('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '-d', lib.parseDbUrl(restoreDatabaseUrl).database, priv['database.dump.enc'].replace(/\.enc$/, '')],
      { env: lib.pgEnv(restoreDatabaseUrl) });

    log('extracting storage archives ...');
    for (const a of ARCHIVES) {
      const dest = a.dirKey === 'documents' ? restoreDocumentsDir : restoreBankDir;
      const entries = await archive.readArchive(fs.createReadStream(priv[a.name].replace(/\.enc$/, '')), dest);
      const expected = manifest.artifacts.find((x) => x.name === a.name).files;
      if (entries.length !== expected) throw new BackupError(`${a.name}: extracted ${entries.length} files, manifest says ${expected}`);
    }

    log('verifying restored data ...');
    const report = await verifyRestored({ restoreDatabaseUrl, restoreDocumentsDir, restoreBankDir, manifest });
    return { manifest, report };
  } catch (err) {
    err.partialRestore = true;
    throw err;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------- prune (manual retention) ----------------
function pruneBackups(root, { apply = false, policy } = {}) {
  const names = fs.readdirSync(root).filter((n) => lib.parseBackupDirName(n) && fs.existsSync(path.join(root, n, 'manifest.json')));
  const plan = lib.planRetention(names, policy);
  if (apply) for (const n of plan.remove) fs.rmSync(path.join(root, n), { recursive: true, force: true });
  return { ...plan, applied: apply };
}

module.exports = { createBackup, verifyArtifacts, assertSafeRestoreTarget, sameServerDatabase, serverIdentity, verifyRestored, restoreBackup, pruneBackups, defaultStorageDirs, TARGET_NAME_RE, TARGET_MARKER };
