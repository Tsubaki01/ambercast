import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from '../../src/ports/storage.js';

export interface StorageContractHarness {
  createStorage(): StorageAdapter | Promise<StorageAdapter>;
  dispose?(): void | Promise<void>;
}

async function withStorage(
  harness: StorageContractHarness,
  assertion: (storage: StorageAdapter) => Promise<void>,
): Promise<void> {
  try {
    await assertion(await harness.createStorage());
  } finally {
    await harness.dispose?.();
  }
}

export function registerStorageContract(harness: StorageContractHarness): void {
  describe('StorageAdapter contract', () => {
    it('round-trips UTF-8 text', async () => {
      await withStorage(harness, async (storage) => {
        await storage.writeText('artifacts/summary.txt', 'hello, 世界');
        await expect(storage.readText('artifacts/summary.txt')).resolves.toBe('hello, 世界');
      });
    });

    it('round-trips binary data', async () => {
      await withStorage(harness, async (storage) => {
        const bytes = new Uint8Array([0, 1, 255]);
        await storage.writeBinary('artifacts/screenshot.png', bytes);
        await expect(storage.readBinary('artifacts/screenshot.png')).resolves.toEqual(bytes);
      });
    });

    it('reports files but not directories as existing', async () => {
      await withStorage(harness, async (storage) => {
        await expect(storage.exists('runs/result.json')).resolves.toBe(false);
        await storage.writeText('runs/result.json', '{}');
        await storage.ensureDir('runs/empty');

        await expect(storage.exists('runs/result.json')).resolves.toBe(true);
        await expect(storage.exists('runs/empty')).resolves.toBe(false);
      });
    });

    it('lists both empty and absent directories as empty', async () => {
      await withStorage(harness, async (storage) => {
        await storage.ensureDir('empty');

        await expect(storage.listFiles('empty')).resolves.toEqual([]);
        await expect(storage.listFiles('missing')).resolves.toEqual([]);
      });
    });

    it('lists direct regular files as sorted bare names only', async () => {
      await withStorage(harness, async (storage) => {
        await storage.writeText('records/zeta.txt', 'z');
        await storage.writeText('records/alpha.txt', 'a');
        await storage.writeText('records/nested/child.txt', 'child');
        await storage.ensureDir('records/empty-directory');

        await expect(storage.listFiles('records')).resolves.toEqual(['alpha.txt', 'zeta.txt']);
      });
    });

    it('overwrites the same file with the latest write', async () => {
      await withStorage(harness, async (storage) => {
        await storage.writeText('artifact.txt', 'first');
        await storage.writeText('artifact.txt', 'second');

        await expect(storage.readText('artifact.txt')).resolves.toBe('second');
      });
    });

    it('creates missing parent directories while writing', async () => {
      await withStorage(harness, async (storage) => {
        await expect(storage.writeText('new/parent/file.txt', 'created')).resolves.toBeUndefined();
        await expect(storage.readText('new/parent/file.txt')).resolves.toBe('created');
      });
    });

    it('makes ensureDir idempotent', async () => {
      await withStorage(harness, async (storage) => {
        await storage.ensureDir('runs');
        await expect(storage.ensureDir('runs')).resolves.toBeUndefined();
      });
    });

    it('rejects both text and binary reads for a missing path', async () => {
      await withStorage(harness, async (storage) => {
        await expect(storage.readText('missing.txt')).rejects.toBeInstanceOf(Error);
        await expect(storage.readBinary('missing.bin')).rejects.toBeInstanceOf(Error);
      });
    });
  });
}
