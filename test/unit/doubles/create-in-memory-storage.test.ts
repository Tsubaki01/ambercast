import { describe, expect, it } from 'vitest';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';

describe('createInMemoryStorage', () => {
  it('round-trips text and binary content', async () => {
    const storage = createInMemoryStorage();
    const bytes = new Uint8Array([0, 1, 255]);

    await storage.writeText('artifacts/text.txt', 'plain text');
    await storage.writeBinary('artifacts/data.bin', bytes);

    await expect(storage.readText('artifacts/text.txt')).resolves.toBe('plain text');
    await expect(storage.readBinary('artifacts/data.bin')).resolves.toEqual(bytes);
  });

  it('preserves empty text, Unicode text, and zero-byte binary files', async () => {
    const storage = createInMemoryStorage();

    await storage.writeText('empty.txt', '');
    await storage.writeText('unicode.txt', 'こんにちは、世界 🌏');
    await storage.writeBinary('empty.bin', new Uint8Array());

    await expect(storage.readText('empty.txt')).resolves.toBe('');
    await expect(storage.readText('unicode.txt')).resolves.toBe('こんにちは、世界 🌏');
    await expect(storage.readBinary('empty.bin')).resolves.toEqual(new Uint8Array());
  });

  it('uses the second write as the complete replacement content', async () => {
    const storage = createInMemoryStorage();

    await storage.writeText('result.txt', 'first');
    await storage.writeText('result.txt', 'second');

    await expect(storage.readText('result.txt')).resolves.toBe('second');
  });

  it('automatically creates parents for a nested write', async () => {
    const storage = createInMemoryStorage();

    await expect(storage.writeText('new/nested/path/result.txt', 'created')).resolves.toBeUndefined();
    await expect(storage.readText('new/nested/path/result.txt')).resolves.toBe('created');
  });

  it('lists only direct regular files as sorted bare names', async () => {
    const storage = createInMemoryStorage();

    await storage.writeText('records/zeta.txt', 'z');
    await storage.writeText('records/alpha.txt', 'a');
    await storage.writeText('records/nested/child.txt', 'child');
    await storage.ensureDir('records/empty');

    await expect(storage.listFiles('records')).resolves.toEqual(['alpha.txt', 'zeta.txt']);
  });

  it('treats an empty or missing directory as an empty listing', async () => {
    const storage = createInMemoryStorage();
    await storage.ensureDir('empty');

    await expect(storage.listFiles('empty')).resolves.toEqual([]);
    await expect(storage.listFiles('missing')).resolves.toEqual([]);
  });

  it('reports directories and missing paths as not existing', async () => {
    const storage = createInMemoryStorage();
    await storage.ensureDir('directory');

    await expect(storage.exists('directory')).resolves.toBe(false);
    await expect(storage.exists('missing.txt')).resolves.toBe(false);
  });

  it('rejects missing reads while allowing the same paths to be read after writing', async () => {
    const storage = createInMemoryStorage();

    await expect(storage.readText('missing.txt')).rejects.toThrow(Error);
    await expect(storage.readBinary('missing.bin')).rejects.toThrow(Error);

    await storage.writeText('missing.txt', 'now present');
    await storage.writeBinary('missing.bin', new Uint8Array([1]));

    await expect(storage.readText('missing.txt')).resolves.toBe('now present');
    await expect(storage.readBinary('missing.bin')).resolves.toEqual(new Uint8Array([1]));
  });

  it('keeps two storage instances isolated', async () => {
    const first = createInMemoryStorage();
    const second = createInMemoryStorage();

    await first.writeText('shared-name.txt', 'first instance');

    await expect(first.readText('shared-name.txt')).resolves.toBe('first instance');
    await expect(second.exists('shared-name.txt')).resolves.toBe(false);
  });
});
