import type { StorageAdapter } from '../../src/ports/storage.js';

export function createInMemoryStorage(): StorageAdapter {
  return {
    async readText(_path: string): Promise<string> {
      throw new Error('not implemented');
    },
    async writeText(_path: string, _content: string): Promise<void> {
      throw new Error('not implemented');
    },
    async readBinary(_path: string): Promise<Uint8Array> {
      throw new Error('not implemented');
    },
    async writeBinary(_path: string, _content: Uint8Array): Promise<void> {
      throw new Error('not implemented');
    },
    async exists(_path: string): Promise<boolean> {
      throw new Error('not implemented');
    },
    async listFiles(_dir: string): Promise<readonly string[]> {
      throw new Error('not implemented');
    },
    async ensureDir(_dir: string): Promise<void> {
      throw new Error('not implemented');
    },
  };
}
