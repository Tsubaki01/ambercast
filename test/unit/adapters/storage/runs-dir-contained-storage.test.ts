import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { createFsStorage } from '#adapters/storage/fs-storage.js';
import { createRunsDirContainedStorage } from '#adapters/storage/runs-dir-contained-storage.js';
import type { StorageAdapter } from '#ports/storage.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly outside: string; readonly base: StorageAdapter; }> {
  const root = await mkdtemp(join(tmpdir(), 'ambercast-contained-storage-'));
  roots.push(root);
  const outside = await mkdtemp(join(tmpdir(), 'ambercast-contained-outside-'));
  roots.push(outside);
  return { root, outside, base: createFsStorage() };
}

function recording(base: StorageAdapter): StorageAdapter & {
  readonly writeText: ReturnType<typeof vi.fn<StorageAdapter['writeText']>>;
  readonly writeBinary: ReturnType<typeof vi.fn<StorageAdapter['writeBinary']>>;
  readonly ensureDir: ReturnType<typeof vi.fn<StorageAdapter['ensureDir']>>;
} {
  return {
    ...base,
    writeText: vi.fn<StorageAdapter['writeText']>(base.writeText),
    writeBinary: vi.fn<StorageAdapter['writeBinary']>(base.writeBinary),
    ensureDir: vi.fn<StorageAdapter['ensureDir']>(base.ensureDir),
  };
}

describe('createRunsDirContainedStorage', () => {
  it.each([
    ['writeText', async (storage: Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'>, path: string) => storage.writeText(path, 'text')],
    ['writeBinary', async (storage: Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'>, path: string) => storage.writeBinary(path, new Uint8Array([1, 2, 3]))],
    ['ensureDir', async (storage: Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'>, path: string) => storage.ensureDir(path)],
  ])('permits $0 inside the resolved root', async (_name, write) => {
    const { root, base } = await fixture();
    const contained = createRunsDirContainedStorage(base)(root);

    await expect(write(contained, join(root, 'nested', 'target'))).resolves.toBeUndefined();
  });

  it('permits the resolved root itself', async () => {
    const { root, base } = await fixture();
    const contained = createRunsDirContainedStorage(base)(root);

    await expect(contained.ensureDir(root)).resolves.toBeUndefined();
  });

  it('permits a child whose name starts with two dots', async () => {
    const { root, base } = await fixture();
    const contained = createRunsDirContainedStorage(base)(root);

    await expect(contained.writeText(join(root, '..cache', 'target.txt'), 'text')).resolves.toBeUndefined();
  });

  it.each([
    ['writeText', async (storage: Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'>, path: string) => storage.writeText(path, 'text'), 'writeText'],
    ['writeBinary', async (storage: Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'>, path: string) => storage.writeBinary(path, new Uint8Array([1])), 'writeBinary'],
    ['ensureDir', async (storage: Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'>, path: string) => storage.ensureDir(path), 'ensureDir'],
  ] as const)('rejects $0 outside root before delegation', async (_name, write, method) => {
    const { root, outside, base } = await fixture();
    const observed = recording(base);
    const contained = createRunsDirContainedStorage(observed)(root);
    const rejectedPath = join(outside, 'escape');

    await expect(write(contained, rejectedPath)).rejects.toMatchObject({
      constructor: IntegrityViolationError,
      details: { path: rejectedPath, root },
    });
    expect(observed[method]).not.toHaveBeenCalled();
  });

  it('rejects immediate and deep symlink escapes, including missing segments below the grandparent', async (context) => {
    const { root, outside, base } = await fixture();
    await mkdir(root, { recursive: true });
    try {
      await symlink(outside, join(root, 'immediate'));
      await mkdir(join(root, 'nested'));
      await symlink(outside, join(root, 'nested', 'grandparent'));
    } catch (error) {
      if (error instanceof Error && ('code' in error) && (error.code === 'EPERM' || error.code === 'EACCES')) {
        context.skip(`Symbolic links require unavailable filesystem permission (${error.code}).`);
      }
      throw error;
    }
    const contained = createRunsDirContainedStorage(base)(root);

    await expect(contained.writeText(join(root, 'immediate', 'escape.txt'), 'escape')).rejects.toBeInstanceOf(IntegrityViolationError);
    await expect(contained.writeText(join(root, 'nested', 'grandparent', 'missing', 'more', 'escape.txt'), 'escape')).rejects.toBeInstanceOf(IntegrityViolationError);
  });

  it('permits a symlinked root and exercises absolute and relative symlink targets that remain contained', async (context) => {
    const { root, base } = await fixture();
    const realRoot = join(root, 'real');
    const rootLink = join(root, 'root-link');
    const relativeLink = join(realRoot, 'relative');
    const absoluteLink = join(realRoot, 'absolute');
    await mkdir(join(realRoot, 'target'), { recursive: true });
    try {
      await symlink(realRoot, rootLink);
      await symlink('target', relativeLink);
      await symlink(join(realRoot, 'target'), absoluteLink);
    } catch (error) {
      if (error instanceof Error && ('code' in error) && (error.code === 'EPERM' || error.code === 'EACCES')) {
        context.skip(`Symbolic links require unavailable filesystem permission (${error.code}).`);
      }
      throw error;
    }
    const contained = createRunsDirContainedStorage(base)(rootLink);

    await expect(contained.writeText(join(rootLink, 'relative', 'one.txt'), 'one')).resolves.toBeUndefined();
    await expect(contained.writeText(join(rootLink, 'absolute', 'two.txt'), 'two')).resolves.toBeUndefined();
  });

  it('permits a fresh, non-existent root and several missing target segments beneath an existing root', async () => {
    const { root, base } = await fixture();
    const freshRoot = join(root, 'not-created');
    await expect(createRunsDirContainedStorage(base)(freshRoot).writeText(join(freshRoot, 'a', 'b', 'file.txt'), 'fresh')).resolves.toBeUndefined();
    const existingRoot = join(root, 'existing');
    await mkdir(existingRoot);
    await expect(createRunsDirContainedStorage(base)(existingRoot).writeBinary(join(existingRoot, 'a', 'b', 'c', 'file.bin'), new Uint8Array([9]))).resolves.toBeUndefined();
  });

  it('rejects an existing real directory outside root and lexical-prefix siblings', async () => {
    const { root, outside, base } = await fixture();
    await mkdir(join(outside, 'real-directory'));
    const sibling = `${root}-evil`;
    await mkdir(sibling);
    roots.push(sibling);
    const contained = createRunsDirContainedStorage(base)(root);

    await expect(contained.ensureDir(join(outside, 'real-directory'))).rejects.toBeInstanceOf(IntegrityViolationError);
    await expect(contained.ensureDir(join(sibling, 'child'))).rejects.toBeInstanceOf(IntegrityViolationError);
  });
});
