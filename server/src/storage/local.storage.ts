import fs from 'fs/promises';
import path from 'path';
import { StorageAdapter } from './storage.adapter';

export class LocalStorageAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolveKey(storageKey: string): string {
    const resolved = path.resolve(this.root, storageKey);
    const prefix = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    if (!resolved.startsWith(prefix)) {
      throw new Error('Invalid storage key');
    }
    return resolved;
  }

  async put(storageKey: string, data: Buffer): Promise<void> {
    const target = this.resolveKey(storageKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { flag: 'wx' });
  }

  async get(storageKey: string): Promise<Buffer> {
    return fs.readFile(this.resolveKey(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await fs.unlink(this.resolveKey(storageKey));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
