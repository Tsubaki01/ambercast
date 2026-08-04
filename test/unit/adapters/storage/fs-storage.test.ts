import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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

function isSymbolicLinkPermissionError(error: unknown): error is { readonly code: 'EACCES' | 'EPERM' } {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false;
  }

  return error.code === 'EACCES' || error.code === 'EPERM';
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }

  return typeof error.code === 'string' ? error.code : undefined;
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

  it('distinguishes successful empty text from a missing file', async () => {
    await withIsolatedStorage(async (storage) => {
      await storage.writeText('empty.txt', '');

      await expect(storage.readText('empty.txt')).resolves.toBe('');
    });
  });

  it('does not report or list a dangling symbolic link as a regular file', async (context) => {
    await withIsolatedStorage(async (storage) => {
      try {
        await symlink('missing-target.txt', 'dangling-link.txt');
      } catch (error) {
        if (isSymbolicLinkPermissionError(error)) {
          context.skip(`Symbolic links require unavailable filesystem permission (${error.code}).`);
        }

        throw error;
      }

      await expect(storage.exists('dangling-link.txt')).resolves.toBe(false);
      await expect(storage.listFiles('')).resolves.toEqual([]);
    });
  });

  it('rejects file and directory name conflicts', async () => {
    await withIsolatedStorage(async (storage) => {
      await mkdir('directory');
      await writeFile('file.txt', 'existing file', 'utf8');

      await expect(storage.writeText('directory', 'cannot replace a directory')).rejects.toBeInstanceOf(Error);
      await expect(storage.ensureDir('file.txt')).rejects.toBeInstanceOf(Error);
    });
  });

  it('resolves false rather than rejecting when a path has a file component', async () => {
    await withIsolatedStorage(async (storage) => {
      await writeFile('not-a-directory', 'file component', 'utf8');

      await expect(storage.exists('not-a-directory/child.txt')).resolves.toBe(false);
    });
  });

  it('rethrows ENOTDIR when listing below a regular file', async () => {
    await withIsolatedStorage(async (storage) => {
      await writeFile('not-a-directory', 'file component', 'utf8');

      let thrown: unknown;
      try {
        await storage.listFiles(join('not-a-directory', 'child.txt'));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(errorCode(thrown)).toBe('ENOTDIR');
    });
  });

  it('rethrows non-missing directory-listing errors when permissions are enforced', async (context) => {
    await withIsolatedStorage(async (storage) => {
      const restrictedDirectory = 'restricted-directory';
      await mkdir(restrictedDirectory);

      try {
        await chmod(restrictedDirectory, 0o000);

        let directListingError: unknown;
        try {
          await readdir(restrictedDirectory);
        } catch (error) {
          directListingError = error;
        }

        if (directListingError === undefined) {
          context.skip('Directory permissions are not enforced; cannot exercise listing error propagation.');
          return;
        }

        if (errorCode(directListingError) === 'EACCES') {
          let thrown: unknown;
          try {
            await storage.listFiles(restrictedDirectory);
          } catch (error) {
            thrown = error;
          }

          expect(thrown).toBeInstanceOf(Error);
          expect(errorCode(thrown)).toBe('EACCES');
          return;
        }

        await expect(storage.listFiles(restrictedDirectory)).rejects.toBeInstanceOf(Error);
      } finally {
        await chmod(restrictedDirectory, 0o700);
      }
    });
  });
});
