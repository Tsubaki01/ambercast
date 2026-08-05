import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Characterizes the published bin/ambercast.js → dist/cli.js path as a child
 * process, verifying byte-identical output end to end so a regression in
 * either the shim or the bundle is caught. npm test's pretest builds dist/
 * first, allowing this test to exercise the built path.
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const binPath = fileURLToPath(new URL('../../bin/ambercast.js', import.meta.url));

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

const EXPECTED_STDOUT = [
  `ambercast v${pkg.version}`,
  '',
  'Prompt-native E2E testing: AI compiles your natural-language test',
  'prompts into a deterministic execution plan, replayed with zero AI calls.',
  '',
  'This package is under active development. The CLI is not functional yet.',
  '',
].join('\n');

describe('bin/ambercast.js (e2e)', () => {
  it('prints the exact placeholder banner and exits 0 with no stderr', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      // Below Vitest's default 5s test timeout, so a hung child process
      // gets killed by execFile's own timeout well before Vitest's — a
      // trivial banner-printing CLI has no legitimate reason to run long.
      timeout: 3_000,
    });

    expect(stderr).toBe('');
    expect(stdout).toBe(EXPECTED_STDOUT);
  });

  it('prints the identical banner regardless of argv, per its documented contract', async () => {
    // src/cli/main.ts documents that every invocation prints the identical
    // banner regardless of argv, so assert that contract explicitly rather
    // than leaving it implied by the no-args case above.
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, '--foo', 'bar'], {
      cwd: repoRoot,
      encoding: 'utf8',
      // Below Vitest's default 5s test timeout, so a hung child process
      // gets killed by execFile's own timeout well before Vitest's — a
      // trivial banner-printing CLI has no legitimate reason to run long.
      timeout: 3_000,
    });

    expect(stderr).toBe('');
    expect(stdout).toBe(EXPECTED_STDOUT);
  });

  it('has a #!/usr/bin/env node shebang as its first line', () => {
    // execFileAsync invokes bin/ambercast.js via `node <path>`, bypassing the
    // shebang, so a direct text assertion is needed to catch a regression.
    const firstLine = readFileSync(binPath, 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });
});
