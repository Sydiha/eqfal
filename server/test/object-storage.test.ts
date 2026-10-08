import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { ObjectStorageAdapter, ObjectStoreClient, ObjectStoreResult, StorageUnavailableError } from '../src/storage/object.storage';
import { readVerified, StorageIntegrityError } from '../src/storage/integrity';
import { LocalStorageAdapter } from '../src/storage/local.storage';
import { assertStorageConfig, getStorage, validateStorageConfig, verifyStorageReady } from '../src/storage/storage.factory';
import fs from 'fs';
import os from 'os';
import path from 'path';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';
const keyA = `${COMPANY_A}/${FILE}`;

/** In-memory stand-in for the SDK client, with the SDK's Result semantics (errors are values, not exceptions). */
class FakeClient implements ObjectStoreClient {
  objects = new Map<string, Buffer>();
  failWith: { message: string; statusCode?: number } | null = null;
  throwOnUse: Error | null = null;
  private guard<T>(): ObjectStoreResult<T> | null {
    if (this.throwOnUse) throw this.throwOnUse;
    return this.failWith ? { ok: false, error: this.failWith } : null;
  }
  async uploadFromBytes(name: string, data: Buffer) { const f = this.guard<null>(); if (f) return f; this.objects.set(name, data); return { ok: true, value: null }; }
  async downloadAsBytes(name: string) {
    const f = this.guard<[Buffer]>(); if (f) return f;
    const o = this.objects.get(name);
    return o ? { ok: true, value: [o] as [Buffer] } : { ok: false, error: { message: `No such object: bucket/${name}`, statusCode: 404 } };
  }
  async delete(name: string) { const f = this.guard<null>(); if (f) return f; this.objects.delete(name); return { ok: true, value: null }; }
  async exists(name: string) { const f = this.guard<boolean>(); if (f) return f; return { ok: true, value: this.objects.has(name) }; }
}

const make = (client: FakeClient, prefix = 'prod/documents', resetClient?: () => void) => new ObjectStorageAdapter({ getClient: () => client, prefix, resetClient });

describe('ObjectStorageAdapter', () => {
  it('stores, reads and deletes under the configured prefix without changing the storage key', async () => {
    const client = new FakeClient();
    const s = make(client);
    await s.put(keyA, Buffer.from('hello'));
    expect([...client.objects.keys()]).toEqual([`prod/documents/${keyA}`]);
    expect((await s.get(keyA)).toString()).toBe('hello');
    await s.delete(keyA);
    expect(client.objects.size).toBe(0);
    await expect(s.delete(keyA)).resolves.toBeUndefined();
  });

  it('is write-once: refuses to overwrite an existing object and keeps the original bytes', async () => {
    const client = new FakeClient();
    const s = make(client);
    await s.put(keyA, Buffer.from('first'));
    await expect(s.put(keyA, Buffer.from('second'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await s.get(keyA)).toString()).toBe('first');
  });

  it('reports a missing object as ENOENT (so routes keep returning 404)', async () => {
    await expect(make(new FakeClient()).get(keyA)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('distinguishes service failures from missing objects (never ENOENT)', async () => {
    for (const failure of [{ message: 'Service Unavailable', statusCode: 503 }, { message: 'Forbidden', statusCode: 403 }, { message: 'The specified bucket does not exist.', statusCode: 404 }, { message: 'socket hang up' }]) {
      const client = new FakeClient();
      client.failWith = failure;
      const s = make(client);
      await expect(s.get(keyA)).rejects.toBeInstanceOf(StorageUnavailableError);
      await expect(s.put(keyA, Buffer.from('x'))).rejects.toBeInstanceOf(StorageUnavailableError);
      await expect(s.delete(keyA)).rejects.toBeInstanceOf(StorageUnavailableError);
    }
  });

  it('fails the upload (no silent success, no local fallback) and writes nothing when the store errors', async () => {
    const client = new FakeClient();
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'eqfal-no-fallback-'));
    client.failWith = { message: 'boom', statusCode: 500 };
    await expect(make(client).put(keyA, Buffer.from('x'))).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(client.objects.size).toBe(0);
    expect(fs.readdirSync(local)).toEqual([]);
  });

  it('turns SDK exceptions (e.g. sidecar unreachable) into StorageUnavailableError and resets the client', async () => {
    const client = new FakeClient();
    client.throwOnUse = new Error('connect ECONNREFUSED 127.0.0.1:1106');
    const reset = vi.fn();
    await expect(make(client, 'prod/documents', reset).get(keyA)).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe or malformed keys before touching the store', async () => {
    const client = new FakeClient();
    const spy = vi.spyOn(client, 'downloadAsBytes');
    const s = make(client);
    for (const bad of ['../etc/passwd', `${COMPANY_A}/../${FILE}`, `/${COMPANY_A}/${FILE}`, `${COMPANY_A}/${FILE}/extra`, 'co-a/file-1', '', `${COMPANY_A}\\${FILE}`, `${COMPANY_A}/${FILE}\0`, `${COMPANY_A}//${FILE}`]) {
      await expect(s.get(bad)).rejects.toThrow('Invalid storage key');
      await expect(s.put(bad, Buffer.from('x'))).rejects.toThrow('Invalid storage key');
      await expect(s.delete(bad)).rejects.toThrow('Invalid storage key');
    }
    expect(spy).not.toHaveBeenCalled();
    expect(client.objects.size).toBe(0);
  });

  it('keeps companies, file kinds and environments apart by prefix and key', async () => {
    const client = new FakeClient();
    const docsProd = make(client, 'prod/documents');
    const bankProd = make(client, 'prod/bank-imports');
    const docsDev = make(client, 'nonprod/documents');
    const keyB = `${COMPANY_B}/${FILE}`;
    await docsProd.put(keyA, Buffer.from('A'));
    await docsProd.put(keyB, Buffer.from('B'));
    expect((await docsProd.get(keyA)).toString()).toBe('A');
    expect((await docsProd.get(keyB)).toString()).toBe('B');
    await expect(bankProd.get(keyA)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(docsDev.get(keyA)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an unsafe prefix', () => {
    expect(() => make(new FakeClient(), '../x')).toThrow('Invalid object storage prefix');
  });

  it('health check writes, reads back and deletes a probe object', async () => {
    const client = new FakeClient();
    await make(client).healthCheck(crypto.randomUUID());
    expect(client.objects.size).toBe(0);
    client.failWith = { message: 'down', statusCode: 503 };
    await expect(make(client).healthCheck(crypto.randomUUID())).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});

describe('readVerified (SHA-256 integrity)', () => {
  const data = Buffer.from('statement bytes');
  const sha = crypto.createHash('sha256').update(data).digest('hex');

  it('returns the bytes when the checksum matches (case-insensitive hex)', async () => {
    const client = new FakeClient();
    const s = make(client);
    await s.put(keyA, data);
    expect((await readVerified(s, keyA, sha)).equals(data)).toBe(true);
    expect((await readVerified(s, keyA, sha.toUpperCase())).equals(data)).toBe(true);
  });

  it('throws StorageIntegrityError when the stored bytes were altered or the recorded hash differs', async () => {
    const client = new FakeClient();
    const s = make(client);
    await s.put(keyA, data);
    client.objects.set(`prod/documents/${keyA}`, Buffer.from('tampered'));
    await expect(readVerified(s, keyA, sha)).rejects.toBeInstanceOf(StorageIntegrityError);
    await expect(readVerified(s, keyA, 'x')).rejects.toBeInstanceOf(StorageIntegrityError);
  });

  it('propagates ENOENT and service failures unchanged', async () => {
    const client = new FakeClient();
    await expect(readVerified(make(client), keyA, sha)).rejects.toMatchObject({ code: 'ENOENT' });
    client.failWith = { message: 'down', statusCode: 503 };
    await expect(readVerified(make(client), keyA, sha)).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('also verifies files read through the local adapter', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eqfal-local-'));
    const s = new LocalStorageAdapter(dir);
    await s.put(keyA, data);
    expect((await readVerified(s, keyA, sha)).equals(data)).toBe(true);
    fs.writeFileSync(path.join(dir, keyA), 'tampered');
    await expect(readVerified(s, keyA, sha)).rejects.toBeInstanceOf(StorageIntegrityError);
  });
});

describe('storage backend selection and startup configuration', () => {
  const object = { STORAGE_BACKEND: 'object', OBJECT_STORAGE_BUCKET_ID: 'bkt-dev' };

  it('defaults to the local adapter for development and tests', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eqfal-default-'));
    expect(getStorage('documents', dir, { NODE_ENV: 'test' })).toBeInstanceOf(LocalStorageAdapter);
    expect(getStorage('bank-imports', dir, {})).toBeInstanceOf(LocalStorageAdapter);
  });

  it('fails closed on Replit production without object storage (both detection paths)', () => {
    for (const env of [{ NODE_ENV: 'production', REPLIT_DEPLOYMENT: '1' }, { REPLIT_DEPLOYMENT: '1' }, { NODE_ENV: 'production', REPL_ID: 'abc' }, { NODE_ENV: 'production', REPLIT_DEPLOYMENT: '1', STORAGE_BACKEND: 'local' }]) {
      expect(() => assertStorageConfig(env)).toThrow(/STORAGE_BACKEND=object is required/);
      expect(() => getStorage('documents', '/tmp/x', env)).toThrow(/Unsafe storage configuration/);
    }
  });

  it('does not use the local disk fallback when production object config is incomplete', () => {
    const env = { NODE_ENV: 'production', REPLIT_DEPLOYMENT: '1', STORAGE_BACKEND: 'object' };
    expect(() => getStorage('documents', '/tmp/x', env)).toThrow(/OBJECT_STORAGE_BUCKET_ID is required/);
  });

  it('requires an explicit bucket id for object storage (the default bucket is never used)', () => {
    expect(validateStorageConfig({ STORAGE_BACKEND: 'object' }).problems.join()).toMatch(/OBJECT_STORAGE_BUCKET_ID/);
    expect(validateStorageConfig(object).problems).toEqual([]);
  });

  it('keeps production object storage blocked until backup support is confirmed (Task 6C-2B)', () => {
    const prod = { ...object, NODE_ENV: 'production', REPLIT_DEPLOYMENT: '1' };
    expect(validateStorageConfig(prod).problems.join()).toMatch(/6C-2B/);
    expect(validateStorageConfig({ ...prod, OBJECT_STORAGE_BACKUP_SUPPORT_CONFIRMED: 'true' }).problems).toEqual([]);
  });

  it('rejects an unknown backend value', () => {
    expect(validateStorageConfig({ STORAGE_BACKEND: 's3' }).problems.join()).toMatch(/STORAGE_BACKEND must be/);
  });

  it('separates production and non-production objects by prefix label', () => {
    expect(validateStorageConfig(object).settings.environmentLabel).toBe('nonprod');
    expect(validateStorageConfig({ ...object, NODE_ENV: 'production' }).settings.environmentLabel).toBe('prod');
  });

  it('builds an object adapter without loading the SDK or contacting the platform', () => {
    expect(getStorage('documents', '/tmp/x', object)).toBeInstanceOf(ObjectStorageAdapter);
  });

  it('startup verification is a no-op for local and fails for an unreachable object store', async () => {
    await expect(verifyStorageReady({ documents: '/tmp/a', 'bank-imports': '/tmp/b' }, { NODE_ENV: 'test' })).resolves.toBeUndefined();
    // No Replit sidecar exists in tests: the SDK cannot initialise, so startup must abort instead of falling back.
    await expect(verifyStorageReady({ documents: '/tmp/a', 'bank-imports': '/tmp/b' }, { ...object, OBJECT_STORAGE_BUCKET_ID: 'bkt-unreachable' })).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});
