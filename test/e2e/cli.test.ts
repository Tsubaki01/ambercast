import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Spawns the real, published entry point (bin/ambercast.js -> dist/cli.js)
 * as a child process. This is deliberately NOT a red-first TDD test: per
 * .claude/impl/issue-10-plan.md "Test strategy", it would already pass
 * against today's pre-issue-#10 bin/ambercast.js unmodified, since exact
 * output preservation is the whole point. It exists as a
 * characterization/regression test proving the full shim -> bundle ->
 * process path stays byte-identical, run via `npm test` (whose `pretest`
 * builds dist/ first) and in CI.
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
    // src/cli/main.ts's JSDoc states every invocation prints the same
    // banner "regardless of argv" since there is no argument parsing yet
    // — assert that explicitly rather than leaving it implied by the
    // no-args case above.
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
    // execFileAsync above invokes bin/ambercast.js via `node <path>`, which
    // bypasses the shebang entirely — it would pass even with a missing or
    // broken shebang. Assert the shebang text directly so a regression in
    // it (this issue's other explicit fix, alongside the exec bit) is
    // actually caught.
    const firstLine = readFileSync(binPath, 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });
});
