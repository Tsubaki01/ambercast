import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsStorage } from '../../../../src/adapters/storage/fs-storage.js';
import { registerStorageContract } from '../../../contracts/storage.contract.js';

let contractRoot: string | undefined;
let contractWorkingDirectory: string | undefined;

async function withIsolatedStorage(
  assertion: (storage: ReturnType<typeof createFsStorage>) => Promise<void>,
): Promise<void> {
  const workingDirectory = process.cwd();
  const root = await mkdtemp(join(tmpdir(), 'ambercast-fs-storage-'));

  try {
    process.chdir(root);
    await assertion(createFsStorage());
  } finally {
    process.chdir(workingDirectory);
    await rm(root, { force: true, recursive: true });
  }
}

registerStorageContract({
  async createStorage() {
    contractWorkingDirectory = process.cwd();
    contractRoot = await mkdtemp(join(tmpdir(), 'ambercast-fs-storage-contract-'));
    process.chdir(contractRoot);

    return createFsStorage();
  },
  async dispose() {
    const root = contractRoot;
    const workingDirectory = contractWorkingDirectory;

    contractRoot = undefined;
    contractWorkingDirectory = undefined;

    try {
      if (workingDirectory !== undefined) {
        process.chdir(workingDirectory);
      }
    } finally {
      if (root !== undefined) {
        await rm(root, { force: true, recursive: true });
      }
    }
  },
});

describe('createFsStorage()', () => {
  it('treats the empty path as the isolated root for directory preparation and listing', async () => {
    await withIsolatedStorage(async (storage) => {
      await expect(storage.ensureDir('')).resolves.toBeUndefined();
      await storage.writeText('root.txt', 'root file');

      await expect(storage.listFiles('')).resolves.toEqual(['root.txt']);
    });
  });

  it('round-trips a Unicode filename', async () => {
    await withIsolatedStorage(async (storage) => {
      const filename = '結果-世界-🌏.txt';

      await storage.writeText(filename, 'Unicode filename content');

      await expect(storage.readText(filename)).resolves.toBe('Unicode filename content');
    });
  });

  it('does not report or list a dangling symbolic link as a regular file', async () => {
    await withIsolatedStorage(async (storage) => {
      await symlink('missing-target.txt', 'dangling-link.txt');

      await expect(storage.exists('dangling-link.txt')).resolves.toBe(false);
      await expect(storage.listFiles('')).resolves.toEqual([]);
    });
  });

  it('preserves Node filesystem errors for file and directory name conflicts', async () => {
    await withIsolatedStorage(async (storage) => {
      await mkdir('directory');
      await writeFile('file.txt', 'existing file', 'utf8');

      await expect(storage.writeText('directory', 'cannot replace a directory')).rejects.toMatchObject({
        code: 'EISDIR',
      });
      await expect(storage.ensureDir('file.txt')).rejects.toMatchObject({ code: 'EEXIST' });
    });
  });

  it('resolves false rather than rejecting when a path has a file component', async () => {
    await withIsolatedStorage(async (storage) => {
      await writeFile('not-a-directory', 'file component', 'utf8');

      await expect(storage.exists('not-a-directory/child.txt')).resolves.toBe(false);
    });
  });
});
