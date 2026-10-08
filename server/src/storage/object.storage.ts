import { StorageAdapter } from './storage.adapter';

/** Subset of the `@replit/object-storage` Client that this adapter uses (the SDK returns Result objects, not exceptions). */
export interface ObjectStoreResult<T> {
  ok: boolean;
  value?: T;
  error?: { message?: string; statusCode?: number } | string;
}
export interface ObjectStoreClient {
  uploadFromBytes(name: string, contents: Buffer): Promise<ObjectStoreResult<null>>;
  downloadAsBytes(name: string): Promise<ObjectStoreResult<[Buffer]>>;
  delete(name: string, options?: { ignoreNotFound?: boolean }): Promise<ObjectStoreResult<null>>;
  exists(name: string): Promise<ObjectStoreResult<boolean>>;
}

/** The object store could not be reached or refused the request. Never means "object missing". */
export class StorageUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';
  constructor(operation: string, detail?: string) {
    super(`Object storage ${operation} failed${detail ? `: ${detail}` : ''}`);
    this.name = 'StorageUnavailableError';
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Keys are generated server-side as `${companyId}/${randomUUID}`; nothing else is accepted. */
const SAFE_KEY = new RegExp(`^${UUID}/${UUID}$`, 'i');
const SAFE_PREFIX = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

function errorInfo(result: ObjectStoreResult<unknown>): { message: string; statusCode?: number } {
  const e = result.error;
  if (typeof e === 'string') return { message: e };
  return { message: e?.message ?? 'unknown error', statusCode: e?.statusCode };
}

/** A 404 only means "missing object" when the service says "No such object"; a missing bucket is also a 404 and must not look like a missing file. Any other wording is treated as a service failure (fail closed). */
function isMissingObject(result: ObjectStoreResult<unknown>): boolean {
  const { message, statusCode } = errorInfo(result);
  return statusCode === 404 && /^no such object/i.test(message);
}

export interface ObjectStorageOptions {
  /** Resolves the SDK client lazily so that merely importing the app never contacts the platform. */
  getClient: () => ObjectStoreClient;
  /** Called after a thrown (non-Result) failure so the next call builds a fresh client. */
  resetClient?: () => void;
  /** Namespace inside the bucket, e.g. `prod/documents`. */
  prefix: string;
}

export class ObjectStorageAdapter implements StorageAdapter {
  constructor(private readonly options: ObjectStorageOptions) {
    if (!SAFE_PREFIX.test(options.prefix)) throw new Error('Invalid object storage prefix');
  }

  private objectName(storageKey: string): string {
    if (typeof storageKey !== 'string' || !SAFE_KEY.test(storageKey)) throw new Error('Invalid storage key');
    return `${this.options.prefix}/${storageKey.toLowerCase()}`;
  }

  private async call<T>(operation: string, fn: (client: ObjectStoreClient) => Promise<ObjectStoreResult<T>>): Promise<ObjectStoreResult<T>> {
    try {
      return await fn(this.options.getClient());
    } catch (err) {
      this.options.resetClient?.();
      throw new StorageUnavailableError(operation, err instanceof Error ? err.message : undefined);
    }
  }

  /** Write-once: refuses to replace an existing object. (The SDK has no atomic precondition; keys are random UUIDs, so collisions are not expected.) */
  async put(storageKey: string, data: Buffer): Promise<void> {
    const name = this.objectName(storageKey);
    const exists = await this.call('exists', (c) => c.exists(name));
    if (!exists.ok) throw new StorageUnavailableError('exists', errorInfo(exists).message);
    if (exists.value) {
      const err = new Error('Storage object already exists') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    }
    const res = await this.call('upload', (c) => c.uploadFromBytes(name, data));
    if (!res.ok) throw new StorageUnavailableError('upload', errorInfo(res).message);
  }

  async get(storageKey: string): Promise<Buffer> {
    const name = this.objectName(storageKey);
    const res = await this.call('download', (c) => c.downloadAsBytes(name));
    if (res.ok && res.value) return res.value[0];
    if (!res.ok && isMissingObject(res)) {
      const err = new Error('Storage object not found') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    throw new StorageUnavailableError('download', errorInfo(res).message);
  }

  async delete(storageKey: string): Promise<void> {
    const name = this.objectName(storageKey);
    const res = await this.call('delete', (c) => c.delete(name, { ignoreNotFound: true }));
    if (!res.ok && !isMissingObject(res)) throw new StorageUnavailableError('delete', errorInfo(res).message);
  }

  /** Startup probe: write, read back, and delete a throw-away object. Throws if the store is not usable. */
  async healthCheck(probeId: string): Promise<void> {
    const name = `${this.options.prefix}/__healthcheck/${probeId}`;
    const payload = Buffer.from(`eqfal-healthcheck-${probeId}`);
    const up = await this.call('probe upload', (c) => c.uploadFromBytes(name, payload));
    if (!up.ok) throw new StorageUnavailableError('probe upload', errorInfo(up).message);
    const down = await this.call('probe download', (c) => c.downloadAsBytes(name));
    if (!down.ok || !down.value || !down.value[0].equals(payload)) throw new StorageUnavailableError('probe download', down.ok ? 'content mismatch' : errorInfo(down).message);
    const del = await this.call('probe delete', (c) => c.delete(name, { ignoreNotFound: true }));
    if (!del.ok) throw new StorageUnavailableError('probe delete', errorInfo(del).message);
  }
}
