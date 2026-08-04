/*
 * Adapts ambercast's storage port to the host filesystem at the real I/O
 * boundary.
 *
 * This adapter owns Node-specific paths and filesystem behavior so core and
 * use cases stay deterministic and can receive storage fakes. Unlike
 * core, adapters have no dependency-cruiser external-module allowlist, so this
 * boundary may import `node:fs/promises` and `node:path` when it implements
 * the port.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StorageAdapter } from '#ports/storage.js';

async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

/**
 * Creates storage backed by the host filesystem.
 *
 * @returns A storage adapter that implements the `StorageAdapter` file
 * contract against Node's filesystem.
 *
 * @remarks
 * Text operations use UTF-8, while binary operations pass bytes
 * through without text encoding. Both write forms prepare missing parent
 * directories before writing, preserving the port's convenience contract
 * without forcing callers to sequence directory creation themselves.
 *
 * The existence probe returns `false` for every inspection
 * failure, including missing paths, directories, and operating-system errors,
 * so callers can use it safely during discovery. Direct-file listings are
 * non-recursive, contain only lexicographically sorted bare regular-file
 * names, and yield `[]` for empty or missing directories. Directory creation
 * is idempotent, including the port's empty-string root directory.
 */
export function createFsStorage(): StorageAdapter {
  return {
    async readText(path: string): Promise<string> {
      return readFile(path, 'utf8');
    },
    async writeText(path: string, content: string): Promise<void> {
      await ensureParentDirectory(path);
      await writeFile(path, content, 'utf8');
    },
    async readBinary(path: string): Promise<Uint8Array> {
      return new Uint8Array(await readFile(path));
    },
    async writeBinary(path: string, content: Uint8Array): Promise<void> {
      await ensureParentDirectory(path);
      await writeFile(path, content);
    },
    async exists(path: string): Promise<boolean> {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
    async listFiles(dir: string): Promise<readonly string[]> {
      try {
        const entries = await readdir(dir || '.', { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort();
      } catch (error: unknown) {
        if (isMissingPathError(error)) {
          return [];
        }

        throw error;
      }
    },
    async ensureDir(dir: string): Promise<void> {
      if (dir !== '') {
        await mkdir(dir, { recursive: true });
      }
    },
  };
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
