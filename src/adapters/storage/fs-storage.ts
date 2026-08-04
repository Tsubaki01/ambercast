/*
 * Adapts ambercast's storage port to the host filesystem at the real I/O
 * boundary.
 *
 * The eventual adapter owns Node-specific paths and filesystem behavior so
 * core and use cases stay deterministic and can receive storage fakes. Unlike
 * core, adapters have no dependency-cruiser external-module allowlist, so this
 * boundary may import `node:fs/promises` and `node:path` when it implements
 * the port.
 */

import type { StorageAdapter } from '#ports/storage.js';

/**
 * Creates storage backed by the host filesystem.
 *
 * @returns A storage adapter that will implement the `StorageAdapter` file
 * contract against Node's filesystem.
 *
 * @remarks
 * Text operations will use UTF-8, while binary operations will pass bytes
 * through without text encoding. Both write forms will prepare missing parent
 * directories before writing, preserving the port's convenience contract
 * without forcing callers to sequence directory creation themselves.
 *
 * The eventual existence probe will return `false` for every inspection
 * failure, including missing paths, directories, and operating-system errors,
 * so callers can use it safely during discovery. Direct-file listings will be
 * non-recursive, contain only lexicographically sorted bare regular-file
 * names, and yield `[]` for empty or missing directories. Directory creation
 * will be idempotent, including the port's empty-string root directory.
 */
export function createFsStorage(): StorageAdapter {
  return {
    /**
     * The eventual read will decode a regular file as UTF-8 and let ordinary
     * read failures distinguish missing files from successful empty content.
     */
    async readText(_path: string): Promise<string> {
      throw new Error('not implemented');
    },
    /**
     * The eventual write will create any missing parent directories before
     * replacing the target's UTF-8 content.
     */
    async writeText(_path: string, _content: string): Promise<void> {
      throw new Error('not implemented');
    },
    /**
     * The eventual read will return a regular file's original bytes without a
     * decoding step that could alter binary artifacts.
     */
    async readBinary(_path: string): Promise<Uint8Array> {
      throw new Error('not implemented');
    },
    /**
     * The eventual write will create missing parents and persist bytes without
     * applying a text encoding.
     */
    async writeBinary(_path: string, _content: Uint8Array): Promise<void> {
      throw new Error('not implemented');
    },
    /**
     * The eventual probe will translate every host inspection failure into
     * `false`, preserving this port's never-reject discovery contract.
     */
    async exists(_path: string): Promise<boolean> {
      throw new Error('not implemented');
    },
    /**
     * The eventual listing will inspect direct entries only, retain regular
     * files, and sort their bare names while treating a missing directory as
     * an empty result rather than a discovery failure.
     */
    async listFiles(_dir: string): Promise<readonly string[]> {
      throw new Error('not implemented');
    },
    /**
     * The eventual directory preparation will tolerate an existing directory
     * and the root representation so callers need no existence preflight.
     */
    async ensureDir(_dir: string): Promise<void> {
      throw new Error('not implemented');
    },
  };
}
