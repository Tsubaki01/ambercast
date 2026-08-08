import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { createFsTestFileDiscovery } from '#runtime/test-file-discovery.js';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ambercast-discovery-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'nested', '.runs'), { recursive: true });
  await writeFile(join(directory, 'login.test.md'), 'login');
  await writeFile(join(directory, 'nested', 'checkout.test.md'), 'checkout');
  await writeFile(join(directory, 'nested', '.runs', 'cached.test.md'), 'cached');
  await writeFile(join(directory, 'notes.md'), 'notes');
  await writeFile(join(directory, '[literal].test.md'), 'literal');
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('createFsTestFileDiscovery', () => {
  it('returns POSIX-relative, deduplicated lexical matches and honors ignore precedence', async () => {
    const testDir = await fixture();
    const discover = createFsTestFileDiscovery();

    await expect(discover({
      testDir,
      testMatch: ['**/*.test.md', 'nested/*.test.md'],
      testIgnore: ['**/.runs/**'],
    })).resolves.toEqual(['[literal].test.md', 'login.test.md', 'nested/checkout.test.md']);
  });

  it('treats double-star as zero or more path segments', async () => {
    const testDir = await fixture();
    const discover = createFsTestFileDiscovery();

    await expect(discover({ testDir, testMatch: ['**/login.test.md'], testIgnore: [] }))
      .resolves.toEqual(['login.test.md']);
  });

  it('escapes unsupported glob syntax rather than treating it as a general glob language', async () => {
    const testDir = await fixture();
    const discover = createFsTestFileDiscovery();

    await expect(discover({ testDir, testMatch: ['[literal].test.md'], testIgnore: [] }))
      .resolves.toEqual(['[literal].test.md']);
    await expect(discover({ testDir, testMatch: ['{login,nested}/*.test.md'], testIgnore: [] }))
      .resolves.toEqual([]);
  });

  it('treats a missing test directory as a zero-match result', async () => {
    const testDir = await fixture();
    const missingTestDir = join(testDir, 'missing');
    const discover = createFsTestFileDiscovery();

    await expect(discover({ testDir: missingTestDir, testMatch: ['**/*.test.md'], testIgnore: [] }))
      .resolves.toEqual([]);
  });

  it('wraps a non-ENOENT directory read failure as a classified filesystem error', async () => {
    const testDir = await fixture();
    const discover = createFsTestFileDiscovery();
    const result = discover({ testDir: join(testDir, 'notes.md'), testMatch: ['**/*.test.md'], testIgnore: [] });

    await expect(result).rejects.toBeInstanceOf(FsIoError);
    await expect(result)
      .rejects.toMatchObject({
        kind: 'fs-io-error',
        message: 'The test directory could not be read.',
      });
  });
});
