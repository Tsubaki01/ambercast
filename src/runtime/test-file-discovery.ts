/**
 * Provides the runtime-owned filesystem discovery seam for configured test
 * prompts.
 */

import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { matchesTestPatterns } from '#core/discovery/pattern-match.js';
import { FsIoError } from '#core/errors/fs-io-error.js';

/**
 * Discovers configured Markdown test files in deterministic path order.
 *
 * The returned paths are POSIX-relative to `config.testDir`, never absolute;
 * generation anchors them to that directory before using storage or layout.
 */
export type TestFileDiscovery = (config: {
  readonly testDir: string;
  readonly testMatch: readonly string[];
  readonly testIgnore: readonly string[];
}) => Promise<readonly string[]>;

/**
 * Creates the filesystem implementation of configured test discovery.
 *
 * @returns A discovery function for the resolved test directory and patterns.
 * @remarks
 * Discovery returns deduplicated, lexicographically sorted POSIX-relative
 * paths. This makes its result a stable execution order for the use case that
 * receives this injected seam.
 *
 * Match-testing delegates to `#core/discovery/pattern-match.js`, whose
 * canonical documentation defines the bounded glob contract
 * shared with inverse-derived artifact-path judgment.
 */
export function createFsTestFileDiscovery(): TestFileDiscovery {
  return async ({ testDir, testMatch, testIgnore }) => {
    let entries;
    try {
      entries = await readdir(testDir, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return [];
      }

      throw new FsIoError('The test directory could not be read.', undefined, { cause: error });
    }
    const files = new Set<string>();

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const path = relative(testDir, join(entry.parentPath, entry.name)).split(sep).join('/');
      if (matchesTestPatterns(path, testMatch, testIgnore)) {
        files.add(path);
      }
    }

    return [...files].sort();
  };
}
