import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import type { StorageAdapter } from '#ports/storage.js';

/*
 * This filesystem-only boundary keeps heal's untracked evidence writes inside
 * a case's resolved runs directory. It detects a symlink that already exists
 * when validation begins, but a concurrent adversary can still replace a
 * checked path before the delegated write; closing that window needs
 * fd-relative no-follow primitives absent from the storage port.
 */

/**
 * Creates write-only storage constrained to a supplied runs-directory root.
 *
 * @param base - Real storage that performs a write after containment validation.
 * @returns A root-bound view exposing only the operations the boundary guards.
 * @remarks
 * Runtime composes this factory once with its filesystem storage, while the
 * usecase supplies the root for each case. Keeping the root curried preserves
 * that layering because the evidence directory varies with the case.
 *
 * The check resolves both the requested path and its root through the
 * filesystem so a pre-existing symlink cannot redirect a write outside the
 * case's evidence directory. The returned view resolves the effective real
 * path of both the containment root and requested write target via the private
 * `resolveEffectiveRealPath` helper, and rejects with
 * `IntegrityViolationError` containing `{ path, root }` details unless the
 * target is the root itself or a proper, segment-boundary-aware descendant.
 * A lexical string-prefix check is insufficient and is not what this
 * containment check performs.
 */
export function createRunsDirContainedStorage(
  base: StorageAdapter,
): (root: string) => Pick<StorageAdapter, 'writeText' | 'writeBinary' | 'ensureDir'> {
  return (root: string) => {
    const assertContained = async (path: string): Promise<void> => {
      const [resolvedRoot, resolvedPath] = await Promise.all([
        resolveEffectiveRealPath(root),
        resolveEffectiveRealPath(path),
      ]);
      const relativePath = relative(resolvedRoot, resolvedPath);
      if (relativePath !== '' && (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))) {
        throw new IntegrityViolationError('Write path escapes the case runs directory.', { path, root });
      }
    };

    return {
      async writeText(path, content) {
        await assertContained(path);
        await base.writeText(path, content);
      },
      async writeBinary(path, content) {
        await assertContained(path);
        await base.writeBinary(path, content);
      },
      async ensureDir(path) {
        await assertContained(path);
        await base.ensureDir(path);
      },
    };
  };
}

/**
 * Resolves a path through its nearest existing ancestor without requiring the
 * full path to exist.
 *
 * @remarks
 * The resolver walks upward only when `realpath` reports `ENOENT`; any other
 * filesystem error propagates because an inaccessible path must not be treated
 * as merely absent. Once an ancestor resolves, the segments traversed on the
 * way up are reattached to that ancestor's resolved real path. Applying this
 * same resolution to both the containment root and the write target lets a
 * fresh project's not-yet-created evidence directory resolve correctly instead
 * of failing before ordinary storage can create it.
 */
async function resolveEffectiveRealPath(path: string): Promise<string> {
  let currentPath = path;
  const missingSegments: string[] = [];
  let originalError: unknown;

  for (;;) {
    try {
      return join(await realpath(currentPath), ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      originalError ??= error;

      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) throw originalError;
      missingSegments.unshift(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
