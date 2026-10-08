import crypto from 'crypto';
import { LocalStorageAdapter } from './local.storage';
import { ObjectStorageAdapter, ObjectStoreClient } from './object.storage';
import { StorageAdapter } from './storage.adapter';

export type StorageKind = 'documents' | 'bank-imports';
export type StorageBackend = 'local' | 'object';

export interface StorageSettings {
  backend: StorageBackend;
  bucketId: string;
  /** `prod` or `nonprod`: keeps development and production objects apart even if a bucket were shared by mistake. */
  environmentLabel: 'prod' | 'nonprod';
  replitProduction: boolean;
}

const flag = (v: string | undefined): boolean => (v ?? '').trim() !== '';

/** Replit deployments set REPLIT_DEPLOYMENT; REPL_ID + NODE_ENV=production covers a production-mode Repl. */
export function isReplitProduction(env: NodeJS.ProcessEnv): boolean {
  return flag(env['REPLIT_DEPLOYMENT']) || (env['NODE_ENV'] === 'production' && flag(env['REPL_ID']));
}

/**
 * Pure validation of the storage environment (no network). Returns problems; messages name variables only.
 *
 * - Replit production must use object storage: its local disk is ephemeral, so there is no local fallback.
 * - Object storage always needs an explicit OBJECT_STORAGE_BUCKET_ID (the platform default bucket is never used),
 *   so development and production cannot share a bucket by accident.
 * - In production, object storage additionally requires OBJECT_STORAGE_BACKUP_SUPPORT_CONFIRMED=true. The backup
 *   tool does not cover object storage until Task 6C-2B; until then production must not be activated.
 */
export function validateStorageConfig(env: NodeJS.ProcessEnv): { problems: string[]; settings: StorageSettings } {
  const problems: string[] = [];
  const raw = (env['STORAGE_BACKEND'] ?? '').trim().toLowerCase();
  if (raw !== '' && raw !== 'local' && raw !== 'object') problems.push('STORAGE_BACKEND must be "local" or "object"');
  const replitProduction = isReplitProduction(env);
  const backend: StorageBackend = raw === 'object' ? 'object' : 'local';
  const production = env['NODE_ENV'] === 'production' || replitProduction;
  const bucketId = (env['OBJECT_STORAGE_BUCKET_ID'] ?? '').trim();

  if (replitProduction && backend !== 'object') {
    problems.push('STORAGE_BACKEND=object is required on a Replit production deployment (local disk is not persistent); there is no local fallback');
  }
  if (backend === 'object') {
    if (!bucketId) problems.push('OBJECT_STORAGE_BUCKET_ID is required when STORAGE_BACKEND=object (the default bucket is never used)');
    if (production && env['OBJECT_STORAGE_BACKUP_SUPPORT_CONFIRMED'] !== 'true') {
      problems.push('Object storage must not be used in production until backup/restore supports it (Task 6C-2B); OBJECT_STORAGE_BACKUP_SUPPORT_CONFIRMED=true is the owner-approved switch');
    }
  }
  return { problems, settings: { backend, bucketId, environmentLabel: production ? 'prod' : 'nonprod', replitProduction } };
}

/** Throws (aborting startup) when the storage environment is unsafe. */
export function assertStorageConfig(env: NodeJS.ProcessEnv = process.env): void {
  const { problems } = validateStorageConfig(env);
  if (problems.length) throw new Error(`Unsafe storage configuration:\n- ${problems.join('\n- ')}`);
}

interface SdkModule { Client: new (options: { bucketId: string }) => ObjectStoreClient }

function createObjectAdapter(kind: StorageKind, settings: StorageSettings): ObjectStorageAdapter {
  let client: ObjectStoreClient | null = null;
  return new ObjectStorageAdapter({
    prefix: `${settings.environmentLabel}/${kind}`,
    getClient: () => {
      if (!client) {
        // Loaded lazily: the SDK contacts the Replit sidecar on construction, so development and tests never load it.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sdk = require('@replit/object-storage') as SdkModule;
        client = new sdk.Client({ bucketId: settings.bucketId });
      }
      return client;
    },
    resetClient: () => { client = null; },
  });
}

const cache = new Map<string, StorageAdapter>();

/**
 * Single place that chooses the backend for both document and bank-import files (including the resume route).
 * Never falls back from object to local: a misconfigured object backend throws.
 */
export function getStorage(kind: StorageKind, localDir: string, env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const { problems, settings } = validateStorageConfig(env);
  if (problems.length) throw new Error(`Unsafe storage configuration:\n- ${problems.join('\n- ')}`);
  const cacheKey = `${settings.backend}|${settings.bucketId}|${settings.environmentLabel}|${kind}|${localDir}`;
  let adapter = cache.get(cacheKey);
  if (!adapter) {
    adapter = settings.backend === 'object' ? createObjectAdapter(kind, settings) : new LocalStorageAdapter(localDir);
    cache.set(cacheKey, adapter);
  }
  return adapter;
}

/** Startup probe for the object backend (no-op for local). A failure aborts startup, so the app never runs half-configured. */
export async function verifyStorageReady(localDirs: Record<StorageKind, string>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { settings } = validateStorageConfig(env);
  if (settings.backend !== 'object') return;
  for (const kind of ['documents', 'bank-imports'] as StorageKind[]) {
    const adapter = getStorage(kind, localDirs[kind], env) as ObjectStorageAdapter;
    await adapter.healthCheck(crypto.randomUUID());
  }
}
