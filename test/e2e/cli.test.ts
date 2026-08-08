import { execFile } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ReportEnvelope } from '#report/schema.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const binPath = fileURLToPath(new URL('../../bin/ambercast.js', import.meta.url));
const temporaryDirectories: string[] = [];

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function runCli(args: readonly string[], cwd = repoRoot): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, ...args], { cwd, encoding: 'utf8', timeout: 5_000 });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code ?? 1 };
  }
}

async function fixtureProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ambercast-cli-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'tests'), { recursive: true });
  await writeFile(join(directory, 'ambercast.config.json'), JSON.stringify({
    $schema: 'https://ambercast.dev/schema/config.json', testDir: 'tests', runsDir: 'tests/.runs',
    targets: { web: { baseUrl: 'https://example.test', browser: 'chromium' } }, defaultTarget: 'web', ai: { provider: 'codex' },
  }));
  await writeFile(join(directory, 'tests', 'test.test.md'), '# Fixture test\n');
  return directory;
}

// The published-path check exercises only list mode, so no test can reach a
// locally installed provider CLI or depend on provider credentials.

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('bin/ambercast.js (e2e)', () => {
  it('runs the built dist path, prints no-command usage, and exits 0', async () => {
    const result = await runCli([]);

    expect(result.stdout).toMatch(/usage/i);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ['--version', /^ambercast v\d+\.\d+\.\d+/, 0],
    ['--help', /generate/, 0],
  ] as const)('short-circuits %s through the published bin path', async (argument, output, exitCode) => {
    const result = await runCli([argument]);

    expect(result.stdout).toMatch(output);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(exitCode);
  });

  it('keeps parse failure plain text even when --json is present', async () => {
    const result = await runCli(['generate', '--json', '--invalid']);

    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/usage|unknown/i);
    expect(result.stderr.trim().startsWith('{')).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it('round-trips list mode for a fixture test through the built dist CLI', async () => {
    const project = await fixtureProject();
    const result = await runCli(['generate', '--list', '--json'], project);

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope.results).toEqual([expect.objectContaining({ file: expect.stringContaining('test.test.md'), status: 'listed' })]);
  });

  it('has a #!/usr/bin/env node shebang as its first line', async () => {
    const firstLine = (await readFile(binPath, 'utf8')).split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it('is executable as published', async () => {
    await expect(access(binPath, constants.X_OK)).resolves.toBeUndefined();
  });
});
