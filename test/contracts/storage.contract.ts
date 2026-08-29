import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from '../../src/ports/storage.js';

export interface StorageContractHarness {
  createStorage(): StorageAdapter | Promise<StorageAdapter>;
  dispose?(): void | Promise<void>;
}

interface StorageWriteCase {
  readonly name: string;
  readonly fileName: string;
  write(storage: StorageAdapter, path: string): Promise<void>;
}

const storageWriteCases: readonly StorageWriteCase[] = [
  {
    name: 'text',
    fileName: 'completed.txt',
    async write(storage, path): Promise<void> {
      await storage.writeText(path, 'complete text');
    },
  },
  {
    name: 'binary',
    fileName: 'completed.bin',
    async write(storage, path): Promise<void> {
      await storage.writeBinary(path, new Uint8Array([0, 1, 255]));
    },
  },
];

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

    it('encodes text as UTF-8 when reading it through the binary view', async () => {
      await withStorage(harness, async (storage) => {
        const text = 'hello, 世界';
        await storage.writeText('artifacts/summary.txt', text);

        await expect(storage.readBinary('artifacts/summary.txt')).resolves.toEqual(new TextEncoder().encode(text));
      });
    });

    it('returns a detached UTF-8 text snapshot from one observed byte sequence', async () => {
      await withStorage(harness, async (storage) => {
        const path = 'artifacts/snapshot.txt';
        const bytes = new Uint8Array([0x68, 0x69, 0x80]);
        await storage.writeBinary(path, bytes);

        const snapshot = await storage.readTextSnapshot(path);
        expect(snapshot.text).toBe(new TextDecoder().decode(snapshot.bytes));
        expect(snapshot.bytes).toEqual(bytes);

        snapshot.bytes[0] = 0;
        await expect(storage.readBinary(path)).resolves.toEqual(bytes);

        const retained = await storage.readTextSnapshot(path);
        await storage.writeBinary(path, new Uint8Array([0x78]));
        expect(retained.bytes).toEqual(bytes);
        expect(retained.text).toBe(new TextDecoder().decode(bytes));
      });
    });

    it('round-trips binary data', async () => {
      await withStorage(harness, async (storage) => {
        const bytes = new Uint8Array([0, 1, 255]);
        await storage.writeBinary('artifacts/screenshot.png', bytes);
        await expect(storage.readBinary('artifacts/screenshot.png')).resolves.toEqual(new Uint8Array([0, 1, 255]));

        bytes[0] = 42;
        await expect(storage.readBinary('artifacts/screenshot.png')).resolves.toEqual(new Uint8Array([0, 1, 255]));

        const read = await storage.readBinary('artifacts/screenshot.png');
        read[1] = 42;
        await expect(storage.readBinary('artifacts/screenshot.png')).resolves.toEqual(new Uint8Array([0, 1, 255]));
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

    it('overwrites binary content with the latest write', async () => {
      await withStorage(harness, async (storage) => {
        await storage.writeBinary('artifact.bin', new Uint8Array([1, 2, 3]));
        const replacement = new Uint8Array([4, 5]);
        await storage.writeBinary('artifact.bin', replacement);

        await expect(storage.readBinary('artifact.bin')).resolves.toEqual(replacement);
      });
    });

    // Successful-write cleanup and failed-write directory/sentinel non-corruption
    // are postconditions reachable by both atomic staging-and-rename and non-atomic
    // direct `writeFile` implementations, so they do not by themselves establish
    // that partial writes are never externally visible. FsStorage's staging-before-
    // rename mock tests in `test/unit/adapters/storage/fs-storage.test.ts` exercise
    // the staging-before-rename mechanism that provides that guarantee; no
    // deterministic, portable test is achievable using only the current
    // `StorageAdapter` API.
    it.each(storageWriteCases)('leaves no stray temporary file after a successful $name write', async ({ fileName, write }) => {
      await withStorage(harness, async (storage) => {
        await write(storage, `artifacts/${fileName}`);

        await expect(storage.listFiles('artifacts')).resolves.toEqual([fileName]);
      });
    });

    it.each(storageWriteCases)('leaves the target directory and its sentinel untouched after a failed $name write', async ({ write }) => {
      await withStorage(harness, async (storage) => {
        const targetDirectory = 'artifacts/target-directory';
        const sentinelPath = `${targetDirectory}/sentinel.txt`;
        const sentinelContent = 'sentinel content';

        await storage.ensureDir(targetDirectory);
        await storage.writeText(sentinelPath, sentinelContent);

        await expect(write(storage, targetDirectory)).rejects.toBeInstanceOf(Error);

        await expect(storage.readText(sentinelPath)).resolves.toBe(sentinelContent);
        await expect(storage.readBinary(sentinelPath)).resolves.toEqual(new TextEncoder().encode(sentinelContent));
        await expect(storage.listFiles('artifacts')).resolves.toEqual([]);
      });
    });

    it('creates missing parent directories while writing', async () => {
      await withStorage(harness, async (storage) => {
        await expect(storage.writeText('new/parent/file.txt', 'created')).resolves.toBeUndefined();
        await expect(storage.readText('new/parent/file.txt')).resolves.toBe('created');
      });
    });

    it('creates missing parent directories while writing binary content', async () => {
      await withStorage(harness, async (storage) => {
        const bytes = new Uint8Array([4, 2]);
        await expect(storage.writeBinary('new/parent/file.bin', bytes)).resolves.toBeUndefined();
        await expect(storage.readBinary('new/parent/file.bin')).resolves.toEqual(bytes);
      });
    });

    it('makes ensureDir idempotent', async () => {
      await withStorage(harness, async (storage) => {
        await storage.ensureDir('runs');
        await expect(storage.ensureDir('runs')).resolves.toBeUndefined();
      });
    });

    it('rejects missing paths while allowing the same paths to be read immediately after writing', async () => {
      await withStorage(harness, async (storage) => {
        await expect(storage.readText('missing.txt')).rejects.toBeInstanceOf(Error);
        await expect(storage.readBinary('missing.bin')).rejects.toBeInstanceOf(Error);
        await expect(storage.readTextSnapshot('missing.snapshot')).rejects.toBeInstanceOf(Error);

        await storage.writeText('missing.txt', 'now present');
        await storage.writeBinary('missing.bin', new Uint8Array([1]));

        await expect(storage.readText('missing.txt')).resolves.toBe('now present');
        await expect(storage.readBinary('missing.bin')).resolves.toEqual(new Uint8Array([1]));
      });
    });

    it('rejects both text and binary reads for a directory path', async () => {
      await withStorage(harness, async (storage) => {
        await storage.ensureDir('directory');

        await expect(storage.readText('directory')).rejects.toBeInstanceOf(Error);
        await expect(storage.readBinary('directory')).rejects.toBeInstanceOf(Error);
        await expect(storage.readTextSnapshot('directory')).rejects.toBeInstanceOf(Error);
      });
    });
  });
}
