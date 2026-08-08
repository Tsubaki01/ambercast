/**
 * Provides the runtime-owned filesystem discovery seam for configured test
 * prompts.
 */

import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { FsIoError } from '#core/errors/fs-io-error.js';

function compilePattern(pattern: string): RegExp {
  let expression = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
      continue;
    }
    if (character === '*') {
      expression += '[^/]*';
      continue;
    }

    expression += '\\^$+?.()|[]{}'.includes(character) ? `\\${character}` : character;
  }

  return new RegExp(`${expression}$`);
}

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
 * Its intentionally bounded matcher treats `**` as zero or more complete path
 * segments, including the empty case, and `*` as zero or more characters within
 * one segment. Thus the default recursive test-file pattern also matches
 * `login.test.md` at the test root. Before those substitutions, every other
 * regular-expression metacharacter
 * in a configured pattern is escaped literally; matching is anchored against
 * the complete relative path. The shipped configuration needs only this shape,
 * so the seam deliberately excludes character classes, braces, extglobs, and
 * general glob-language behavior.
 */
export function createFsTestFileDiscovery(): TestFileDiscovery {
  return async ({ testDir, testMatch, testIgnore }) => {
    const matches = testMatch.map(compilePattern);
    const ignored = testIgnore.map(compilePattern);
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
      if (matches.some((pattern) => pattern.test(path)) && !ignored.some((pattern) => pattern.test(path))) {
        files.add(path);
      }
    }

    return [...files].sort();
  };
}
