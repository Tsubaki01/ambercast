import { readFile, stat } from 'node:fs/promises';
import type { ReadStorageAdapter } from '#ports/storage.js';

/*
 * This adapter implements its two reads directly with `node:fs/promises`.
 * It must not import `fs-storage.ts`: the read-only closure rule treats that
 * module as write-capable at file granularity, so even a re-export of only
 * these methods would make every caller reach the prohibited factory module.
 * Duplicating the small read bodies is therefore a hard architectural
 * constraint, not a style preference.
 */

/**
 * Creates read-only storage backed by the host filesystem.
 *
 * @returns A fresh adapter that exposes only UTF-8 text reads and regular
 * file existence probes.
 *
 * @remarks
 * The object contains exactly the two `ReadStorageAdapter`
 * members, rather than a cast or projection of a fuller adapter. This keeps
 * write methods absent at runtime as well as unavailable through the type.
 */
export function createFsReadStorage(): ReadStorageAdapter {
  return {
    async readText(path: string): Promise<string> {
      if (!(await stat(path)).isFile()) {
        throw new Error(`${path} is not a regular file`);
      }

      return readFile(path, 'utf8');
    },
    async exists(path: string): Promise<boolean> {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
  };
}
