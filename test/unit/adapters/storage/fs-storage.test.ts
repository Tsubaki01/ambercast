import * as fsPromises from 'node:fs/promises';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFsStorage } from '../../../../src/adapters/storage/fs-storage.js';
import { registerStorageContract } from '../../../contracts/storage.contract.js';

const originalFsPromises = vi.hoisted(() => ({
  writeFile: undefined as typeof fsPromises.writeFile | undefined,
}));

// Node's ESM namespace exports are non-configurable, so `vi.spyOn` cannot
// intercept them here. The load-time mock retains the real operations while
// making the two atomic-write calls observable to this test.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  originalFsPromises.writeFile = original.writeFile;

  return {
    ...original,
    rename: vi.fn(original.rename),
    rm: vi.fn(original.rm),
    writeFile: vi.fn(original.writeFile),
  };
});

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

interface AtomicWriteCase {
  readonly name: string;
  readonly targetPath: string;
  write(storage: ReturnType<typeof createFsStorage>, path: string): Promise<void>;
}

const atomicWriteCases: readonly AtomicWriteCase[] = [
  {
    name: 'text',
    targetPath: 'nested/dir/atomic-text.txt',
    async write(storage, path): Promise<void> {
      await storage.writeText(path, 'atomic text');
    },
  },
  {
    name: 'binary',
    targetPath: 'atomic-binary.bin',
    async write(storage, path): Promise<void> {
      await storage.writeBinary(path, new Uint8Array([0, 1, 255]));
    },
  },
];

interface SymlinkReplacementWriteCase {
  readonly name: string;
  write(storage: ReturnType<typeof createFsStorage>, path: string): Promise<void>;
  assertContent(storage: ReturnType<typeof createFsStorage>, path: string): Promise<void>;
}

const symlinkReplacementWriteCases: readonly SymlinkReplacementWriteCase[] = [
  {
    name: 'text',
    async write(storage, path): Promise<void> {
      await storage.writeText(path, 'symlink replacement text');
    },
    async assertContent(storage, path): Promise<void> {
      await expect(storage.readText(path)).resolves.toBe('symlink replacement text');
    },
  },
  {
    name: 'binary',
    async write(storage, path): Promise<void> {
      await storage.writeBinary(path, new Uint8Array([4, 8, 15, 16, 23, 42]));
    },
    async assertContent(storage, path): Promise<void> {
      await expect(storage.readBinary(path)).resolves.toEqual(new Uint8Array([4, 8, 15, 16, 23, 42]));
    },
  },
];

function stringPath(path: unknown): string {
  expect(path).toBeTypeOf('string');

  if (typeof path !== 'string') {
    throw new Error('Expected the filesystem operation to receive a string path.');
  }

  return path;
}

function temporaryWritePaths(calls: readonly (readonly unknown[])[], targetPath: string): readonly string[] {
  expect(calls).not.toHaveLength(0);

  const paths = calls.map(([path]) => stringPath(path));
  expect(paths).not.toContain(targetPath);

  for (const temporaryPath of paths) {
    expect(dirname(temporaryPath)).toBe(dirname(targetPath));
  }

  return paths;
}

function hasExclusiveCreateFlag(options: unknown): boolean {
  return typeof options === 'object' && options !== null && 'flag' in options && options.flag === 'wx';
}

function createFilesystemError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function resetAtomicWriteMocks(): void {
  vi.mocked(fsPromises.writeFile).mockReset();
  vi.mocked(fsPromises.rename).mockReset();
  vi.mocked(fsPromises.rm).mockReset();
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
  it.each(atomicWriteCases)('writes $name content to a temporary path before renaming it to the target', async ({ targetPath, write }) => {
    await withIsolatedStorage(async (storage) => {
      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const renameMock = vi.mocked(fsPromises.rename);
      resetAtomicWriteMocks();

      try {
        await write(storage, targetPath);

        const temporaryWrite = writeFileMock.mock.calls[0];
        expect(temporaryWrite).toBeDefined();

        if (temporaryWrite === undefined) {
          throw new Error('Expected writeFile to receive a temporary path.');
        }

        const temporaryPaths = temporaryWritePaths(writeFileMock.mock.calls, targetPath);
        const [temporaryPath] = temporaryWrite;
        expect(temporaryPaths).toContain(stringPath(temporaryPath));
        expect(renameMock).toHaveBeenCalledWith(temporaryPath, targetPath);

        const temporaryWriteOrder = writeFileMock.mock.invocationCallOrder[writeFileMock.mock.calls.indexOf(temporaryWrite)];
        const matchingRenameCallIndex = renameMock.mock.calls.findIndex(([sourcePath, destinationPath]) => {
          return sourcePath === temporaryPath && destinationPath === targetPath;
        });
        const renameOrder = renameMock.mock.invocationCallOrder[matchingRenameCallIndex];

        expect(temporaryWriteOrder).toBeDefined();
        expect(matchingRenameCallIndex).toBeGreaterThanOrEqual(0);
        expect(renameOrder).toBeDefined();

        if (temporaryWriteOrder === undefined || renameOrder === undefined) {
          throw new Error('Expected the temporary write and its target rename to have recorded call order.');
        }

        expect(renameOrder).toBeGreaterThan(temporaryWriteOrder);
      } finally {
        resetAtomicWriteMocks();
      }
    });
  });

  it.each(atomicWriteCases)('waits for the temporary $name write to settle before renaming it to the target', async ({ targetPath, write }) => {
    await withIsolatedStorage(async (storage) => {
      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const renameMock = vi.mocked(fsPromises.rename);
      let resolveTemporaryWrite: (() => void) | undefined;

      resetAtomicWriteMocks();
      writeFileMock.mockImplementationOnce(async (...arguments_) => {
        await new Promise<void>((resolve) => {
          resolveTemporaryWrite = resolve;
        });

        const originalWriteFile = originalFsPromises.writeFile;
        if (originalWriteFile === undefined) {
          throw new Error('Expected the mocked filesystem module to retain its original writeFile implementation.');
        }

        await originalWriteFile(...arguments_);
      });

      try {
        const writing = write(storage, targetPath);
        void writing.catch(() => undefined);

        await vi.waitFor(() => {
          expect(writeFileMock).toHaveBeenCalledTimes(1);
        });
        expect(renameMock).not.toHaveBeenCalled();

        if (resolveTemporaryWrite === undefined) {
          throw new Error('Expected the temporary write to remain pending until this test resolves it.');
        }

        resolveTemporaryWrite();
        await expect(writing).resolves.toBeUndefined();

        const [temporaryPath] = temporaryWritePaths(writeFileMock.mock.calls, targetPath);
        expect(renameMock).toHaveBeenCalledWith(temporaryPath, targetPath);
      } finally {
        resetAtomicWriteMocks();
      }
    });
  });

  it.each(atomicWriteCases)('retries a $name write with a fresh exclusively-created temporary path after an EEXIST collision', async ({ targetPath, write }) => {
    await withIsolatedStorage(async (storage) => {
      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const renameMock = vi.mocked(fsPromises.rename);
      const collisionError = createFilesystemError('EEXIST', 'temporary file already exists');

      resetAtomicWriteMocks();
      writeFileMock.mockRejectedValueOnce(collisionError);

      try {
        await expect(write(storage, targetPath)).resolves.toBeUndefined();

        const paths = temporaryWritePaths(writeFileMock.mock.calls, targetPath);
        expect(paths).toHaveLength(2);
        expect(new Set(paths).size).toBe(2);
        expect(writeFileMock.mock.calls.every(([, , options]) => hasExclusiveCreateFlag(options))).toBe(true);
        expect(renameMock).toHaveBeenCalledWith(paths[1], targetPath);
      } finally {
        resetAtomicWriteMocks();
      }
    });
  });

  it.each(atomicWriteCases)('rejects a $name write after bounded EEXIST collisions without removing another writer\'s temporary path', async ({ targetPath, write }) => {
    await withIsolatedStorage(async (storage) => {
      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const renameMock = vi.mocked(fsPromises.rename);
      const rmMock = vi.mocked(fsPromises.rm);
      const collisionError = createFilesystemError('EEXIST', 'temporary file already exists');

      resetAtomicWriteMocks();
      writeFileMock.mockRejectedValue(collisionError);

      try {
        await expect(write(storage, targetPath)).rejects.toBe(collisionError);

        const paths = temporaryWritePaths(writeFileMock.mock.calls, targetPath);
        expect(paths.length).toBeGreaterThan(1);
        expect(paths.length).toBeLessThanOrEqual(5);
        expect(new Set(paths).size).toBe(paths.length);
        expect(writeFileMock.mock.calls.every(([, , options]) => hasExclusiveCreateFlag(options))).toBe(true);
        expect(renameMock).not.toHaveBeenCalled();
        expect(rmMock).not.toHaveBeenCalled();
      } finally {
        resetAtomicWriteMocks();
      }
    });
  });

  it.each(atomicWriteCases)('removes the $name temporary file and preserves a non-collision temporary-write error', async ({ targetPath, write }) => {
    await withIsolatedStorage(async (storage) => {
      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const renameMock = vi.mocked(fsPromises.rename);
      const rmMock = vi.mocked(fsPromises.rm);
      const writeError = createFilesystemError('EACCES', 'temporary file is not writable');
      const cleanupError = new Error('cleanup failed');

      resetAtomicWriteMocks();
      writeFileMock.mockRejectedValueOnce(writeError);
      rmMock.mockRejectedValueOnce(cleanupError);

      try {
        await expect(write(storage, targetPath)).rejects.toBe(writeError);

        const [temporaryPath] = temporaryWritePaths(writeFileMock.mock.calls, targetPath);
        expect(renameMock).not.toHaveBeenCalled();
        expect(rmMock).toHaveBeenCalledWith(temporaryPath, { force: true });
      } finally {
        resetAtomicWriteMocks();
      }
    });
  });

  it.each(atomicWriteCases)('removes the $name temporary file and preserves the rename error', async ({ targetPath, write }) => {
    await withIsolatedStorage(async (storage) => {
      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const renameMock = vi.mocked(fsPromises.rename);
      const rmMock = vi.mocked(fsPromises.rm);
      const renameError = new Error('rename failed');

      resetAtomicWriteMocks();
      renameMock.mockRejectedValueOnce(renameError);

      try {
        await expect(write(storage, targetPath)).rejects.toBe(renameError);

        const [temporaryPath] = temporaryWritePaths(writeFileMock.mock.calls, targetPath);
        expect(rmMock).toHaveBeenCalledWith(temporaryPath, { force: true });
      } finally {
        resetAtomicWriteMocks();
      }
    });
  });

  it.each(atomicWriteCases)('preserves the $name rename error when temporary-file cleanup also fails', async ({ targetPath, write }) => {
    await withIsolatedStorage(async (storage) => {
      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const renameMock = vi.mocked(fsPromises.rename);
      const rmMock = vi.mocked(fsPromises.rm);
      const renameError = new Error('rename failed');
      const cleanupError = new Error('cleanup failed');

      resetAtomicWriteMocks();
      renameMock.mockRejectedValueOnce(renameError);
      rmMock.mockRejectedValueOnce(cleanupError);

      try {
        await expect(write(storage, targetPath)).rejects.toBe(renameError);

        const [temporaryPath] = temporaryWritePaths(writeFileMock.mock.calls, targetPath);
        expect(rmMock).toHaveBeenCalledWith(temporaryPath, { force: true });
      } finally {
        resetAtomicWriteMocks();
      }
    });
  });

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

  it.for(symlinkReplacementWriteCases)('replaces live and dangling file symbolic links when writing $name content', async ({ write, assertContent }, context) => {
    await withIsolatedStorage(async (storage) => {
      const liveTargetPath = 'live-target.txt';
      const liveLinkPath = 'live-link.txt';
      const danglingTargetPath = 'missing-target.txt';
      const danglingLinkPath = 'dangling-link.txt';

      await writeFile(liveTargetPath, 'original target content', 'utf8');

      try {
        await symlink(liveTargetPath, liveLinkPath, 'file');
        await symlink(danglingTargetPath, danglingLinkPath, 'file');
      } catch (error) {
        if (isSymbolicLinkPermissionError(error)) {
          context.skip(`Symbolic links require unavailable filesystem permission (${error.code}).`);
        }

        throw error;
      }

      await write(storage, liveLinkPath);

      expect((await lstat(liveLinkPath)).isSymbolicLink()).toBe(false);
      await assertContent(storage, liveLinkPath);
      await expect(storage.readText(liveTargetPath)).resolves.toBe('original target content');

      await write(storage, danglingLinkPath);

      expect((await lstat(danglingLinkPath)).isSymbolicLink()).toBe(false);
      await assertContent(storage, danglingLinkPath);
      await expect(lstat(danglingTargetPath)).rejects.toMatchObject({ code: 'ENOENT' });
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
