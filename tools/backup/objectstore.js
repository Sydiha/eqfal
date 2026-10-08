'use strict';
// Object Storage (Replit App Storage) support for the backup tool (Task 6C-2B). READ-ONLY toward the bucket:
// this module only downloads. It never uploads, deletes or lists, and restore never uses it (restore writes only
// to local directories of an isolated test target).
const crypto = require('crypto');
const { BackupError } = require('./lib');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Same rule as server/src/storage/object.storage.ts: keys are generated server-side as `${companyId}/${uuid}`.
const SAFE_KEY = new RegExp(`^${UUID}/${UUID}$`, 'i');

// Fail closed: an unknown STORAGE_BACKEND (or local disk on a Replit production deployment, where only Object Storage
// is persistent) must never silently produce a backup of empty local folders.
function isObjectBackend(env = process.env) {
  const raw = (env.STORAGE_BACKEND ?? '').trim().toLowerCase();
  if (raw !== '' && raw !== 'local' && raw !== 'object') throw new BackupError('STORAGE_BACKEND must be "local" or "object"');
  if (raw !== 'object' && isReplitProduction(env)) throw new BackupError('Replit production uses Object Storage: set STORAGE_BACKEND=object (a local-directory backup would be empty)');
  return raw === 'object';
}

// Mirrors server/src/storage/storage.factory.ts (isReplitProduction + environmentLabel). Kept in sync by a test.
function isReplitProduction(env) {
  const flag = (v) => (v ?? '').trim() !== '';
  return flag(env.REPLIT_DEPLOYMENT) || (env.NODE_ENV === 'production' && flag(env.REPL_ID));
}
function environmentLabel(env = process.env) {
  return env.NODE_ENV === 'production' || isReplitProduction(env) ? 'prod' : 'nonprod';
}
const prefixFor = (kind, env = process.env) => `${environmentLabel(env)}/${kind}`; // kind: 'documents' | 'bank-imports'

function errorInfo(result) {
  const e = result.error;
  if (typeof e === 'string') return { message: e };
  return { message: e?.message ?? 'unknown error', statusCode: e?.statusCode };
}
// Only an explicit "No such object" 404 means a missing file; anything else is a service failure (fail closed).
function isMissingObject(result) {
  const { message, statusCode } = errorInfo(result);
  return statusCode === 404 && /^no such object/i.test(message);
}

// Lazy: the SDK contacts the Replit sidecar on construction, so tests and local backups never load it.
function createReplitClient(bucketId) {
  if (!bucketId) throw new BackupError('OBJECT_STORAGE_BUCKET_ID is required when STORAGE_BACKEND=object (the default bucket is never used)');
  let sdk;
  try { sdk = require('@replit/object-storage'); } catch { throw new BackupError('@replit/object-storage is not installed; run npm ci'); }
  return new sdk.Client({ bucketId });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Download ONE referenced object and prove it matches what the database says. Throws BackupError otherwise.
async function fetchVerified(client, prefix, ref, label) {
  if (typeof ref.key !== 'string' || !SAFE_KEY.test(ref.key)) throw new BackupError(`${label}: unsafe storage_key in database`);
  const name = `${prefix}/${ref.key.toLowerCase()}`;
  let res;
  try { res = await client.downloadAsBytes(name); } catch (err) { throw new BackupError(`${label}: object storage unavailable while reading ${ref.key}: ${err.message}`); }
  if (!res.ok || !res.value) {
    if (!res.ok && isMissingObject(res)) throw new BackupError(`${label}: object MISSING for storage_key ${ref.key} (database references a file that is not in Object Storage)`);
    throw new BackupError(`${label}: object storage error while reading ${ref.key}: ${errorInfo(res).message}`);
  }
  const data = res.value[0];
  if (!Buffer.isBuffer(data)) throw new BackupError(`${label}: unexpected download result for ${ref.key}`);
  if (ref.size !== undefined && ref.size !== null && data.length !== Number(ref.size)) throw new BackupError(`${label}: size mismatch for ${ref.key} (database ${ref.size}, object ${data.length})`);
  if (sha256(data) !== String(ref.sha256).toLowerCase()) throw new BackupError(`${label}: SHA-256 mismatch for ${ref.key} (object differs from the checksum recorded in the database)`);
  return data;
}

// refs: [{ key, sha256, size? }] straight from the database snapshot. Returns archive items (verified lazily, one at a time).
function itemsFor(client, prefix, refs, label) {
  const byKey = new Map();
  for (const r of refs) {
    const prev = byKey.get(r.key.toLowerCase());
    if (prev && prev.sha256 !== r.sha256) throw new BackupError(`${label}: storage_key ${r.key} is referenced with different checksums`);
    byKey.set(r.key.toLowerCase(), r);
  }
  return [...byKey.values()].map((ref) => ({ key: ref.key, load: () => fetchVerified(client, prefix, ref, label) }));
}

module.exports = { isObjectBackend, isReplitProduction, environmentLabel, prefixFor, createReplitClient, fetchVerified, itemsFor, SAFE_KEY };
