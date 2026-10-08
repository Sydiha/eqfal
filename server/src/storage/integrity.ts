import crypto from 'crypto';
import { StorageAdapter } from './storage.adapter';

/** The stored bytes do not match the SHA-256 recorded in the database. The file must not be served or parsed. */
export class StorageIntegrityError extends Error {
  readonly code = 'STORAGE_INTEGRITY';
  constructor(readonly storageKey: string) {
    super('Stored file failed SHA-256 integrity verification');
    this.name = 'StorageIntegrityError';
  }
}

/** Reads a file and verifies it against the checksum already stored in PostgreSQL. Works for every backend. */
export async function readVerified(storage: StorageAdapter, storageKey: string, expectedSha256: string): Promise<Buffer> {
  const data = await storage.get(storageKey);
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (typeof expectedSha256 !== 'string' || actual !== expectedSha256.toLowerCase()) throw new StorageIntegrityError(storageKey);
  return data;
}
