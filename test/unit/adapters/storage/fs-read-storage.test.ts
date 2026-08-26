import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsReadStorage } from '../../../../src/adapters/storage/fs-read-storage.js';

async function withIsolatedStorage(
  assertion: (storage: ReturnType<typeof createFsReadStorage>) => Promise<void>,
): Promise<void> {
  const workingDirectory = process.cwd();
  const root = await mkdtemp(join(tmpdir(), 'ambercast-fs-read-storage-'));

  try {
    process.chdir(root);
    await assertion(createFsReadStorage());
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

describe('createFsReadStorage()', () => {
  it('reads the exact UTF-8 content of an existing file', async () => {
    await withIsolatedStorage(async (storage) => {
      await writeFile('message.txt', 'Hello, 世界 🌏', 'utf8');

      await expect(storage.readText('message.txt')).resolves.toBe('Hello, 世界 🌏');
    });
  });

  it('reports an existing regular file', async () => {
    await withIsolatedStorage(async (storage) => {
      await writeFile('present.txt', 'present', 'utf8');

      await expect(storage.exists('present.txt')).resolves.toBe(true);
    });
  });

  it('rejects a text read for a missing path', async () => {
    await withIsolatedStorage(async (storage) => {
      await expect(storage.readText('missing.txt')).rejects.toBeInstanceOf(Error);
    });
  });

  it('rejects a text read for a directory path', async () => {
    await withIsolatedStorage(async (storage) => {
      await mkdir('directory');

      await expect(storage.readText('directory')).rejects.toThrow('directory is not a regular file');
    });
  });

  it.each([
    { name: 'a missing path', path: 'missing.txt', prepare: async (): Promise<void> => undefined },
    { name: 'a directory path', path: 'directory', prepare: async (): Promise<void> => { await mkdir('directory'); } },
    {
      name: 'an ENOTDIR stat error',
      path: 'not-a-directory/child.txt',
      prepare: async (): Promise<void> => { await writeFile('not-a-directory', 'file', 'utf8'); },
    },
  ] as const)('returns false rather than rejecting for $name', async ({ path, prepare }) => {
    await withIsolatedStorage(async (storage) => {
      await prepare();

      await expect(storage.exists(path)).resolves.toBe(false);
    });
  });

  it('returns false rather than rejecting for a dangling symbolic link', async (context) => {
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
    });
  });

  it('exposes exactly the two read-only operations as own properties', () => {
    expect([...Reflect.ownKeys(createFsReadStorage())].sort()).toEqual(['exists', 'readText']);
  });
});
