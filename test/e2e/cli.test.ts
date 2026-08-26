import { execFile } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import type { JsonValueT, PlanDocument } from '#core/ir/schema.js';
import { ReportEnvelope } from '#report/schema.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const binPath = fileURLToPath(new URL('../../bin/ambercast.js', import.meta.url));
const temporaryDirectories: string[] = [];
const FIXTURE_PROMPT = '# Fixture test\n';

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function runCli(args: readonly string[], cwd = repoRoot, env?: NodeJS.ProcessEnv): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
      ...(env === undefined ? {} : { env }),
    });
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
  await writeFile(join(directory, 'tests', 'test.test.md'), FIXTURE_PROMPT);
  return directory;
}

async function writeSoleTargetConfigAndFreshPlan(project: string): Promise<void> {
  const targetDefinitions = {
    replacement: { baseUrl: 'https://replacement.example.test', browser: 'chromium' as const },
  };
  await writeFile(join(project, 'ambercast.config.json'), JSON.stringify({
    $schema: 'https://ambercast.dev/schema/config.json',
    testDir: 'tests',
    runsDir: 'tests/.runs',
    targets: targetDefinitions,
    ai: { provider: 'codex' },
    ci: { heal: true },
  }));
  const plan = {
    schemaVersion: 2,
    source: {
      inputsDigest: computeInputsDigest({
        normalizedTestMd: normalizeTestMd(FIXTURE_PROMPT),
        schemaVersion: 2,
        generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
        targetDefinitions,
      }),
    },
    targets: targetDefinitions,
    steps: [],
  } as unknown as PlanDocument;
  await writeFile(
    join(project, 'tests', 'test.ambercast.plan.json'),
    toCanonicalArtifactText(plan as unknown as JsonValueT),
  );
  await writeFile(
    join(project, 'tests', 'test.ambercast.grounding.json'),
    toCanonicalArtifactText({ schemaVersion: 1, planDigest: computePlanDigest(plan), entries: {} }),
  );
}

async function writeStalePlan(project: string): Promise<void> {
  await writeFile(join(project, 'tests', 'test.ambercast.plan.json'), toCanonicalArtifactText({
    schemaVersion: 2,
    source: { inputsDigest: 'f'.repeat(64) },
    targets: { web: { baseUrl: 'https://example.test', browser: 'chromium' } },
    steps: [],
  } as unknown as JsonValueT));
}

// Successful list-mode checks and run scenarios that end before fallback
// resolution exercise the published path without requiring a local provider
// CLI or provider credentials.

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
    ['--help', /generate[\s\S]*run/, 0],
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
    expect(envelope.schemaVersion).toBe('2.0');
    expect(envelope.results).toEqual([expect.objectContaining({ file: expect.stringContaining('test.test.md'), status: 'listed' })]);
  });

  it('lists a matched heal file through the built dist CLI without attempting a repair', async () => {
    const project = await fixtureProject();
    const result = await runCli(['heal', '--list', '--json'], project);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({
      command: 'heal',
      summary: { total: 1, passed: 0, failed: 0, errored: 0, skipped: 1 },
      results: [expect.objectContaining({ file: expect.stringContaining('test.test.md'), status: 'listed' })],
      errors: [],
    });
  });

  it('allows a non-interactive CI heal with zero pending commits and no --yes', async () => {
    const project = await fixtureProject();
    await writeSoleTargetConfigAndFreshPlan(project);
    const result = await runCli(['heal', '--list', '--json'], project, { ...process.env, CI: 'true' });

    const envelope = JSON.parse(result.stdout);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(envelope).toMatchObject({
      command: 'heal',
      errors: [],
      results: [expect.objectContaining({ status: 'listed' })],
    });
  });

  it.each(['generate', 'run', 'check'] as const)(
    'reports an invalid explicit target through %s as TARGET_UNRESOLVED with exit 2',
    async (command) => {
      const project = await fixtureProject();

      const result = await runCli([command, '--target', 'missing', '--json'], project);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('');
      const envelope = JSON.parse(result.stdout);
      expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
      expect(envelope.command).toBe(command);
      expect(envelope.errors).toEqual([
        expect.objectContaining({ code: 'TARGET_UNRESOLVED' }),
      ]);
    },
  );

  it('loads one replacement target without inheriting the built-in default and checks a fresh plan', async () => {
    const project = await fixtureProject();
    await writeSoleTargetConfigAndFreshPlan(project);
    const rawConfig = JSON.parse(await readFile(join(project, 'ambercast.config.json'), 'utf8'));

    expect(Object.hasOwn(rawConfig, 'defaultTarget')).toBe(false);
    expect(Object.keys(rawConfig.targets)).toEqual(['replacement']);

    const result = await runCli(['check', '--json'], project);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({
      command: 'check',
      summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
      results: [{ status: 'fresh' }],
      errors: [],
    });
  });

  it('lists a matched run file as a JSON report row without replaying its missing plan', async () => {
    const project = await fixtureProject();
    const result = await runCli(['run', '--list', '--json'], project);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({
      command: 'run',
      reportPersistence: 'persisted',
      summary: { total: 1, passed: 0, failed: 0, errored: 0, skipped: 1 },
      results: [expect.objectContaining({ file: expect.stringContaining('test.test.md'), status: 'listed' })],
    });
    const reportDirectories = await readdir(join(project, 'tests', '.runs'));
    expect(reportDirectories).toHaveLength(1);
    await expect(readFile(join(project, 'tests', '.runs', reportDirectories[0]!, 'report.json'), 'utf8'))
      .resolves.toBe(JSON.stringify(envelope));
  });

  it('renders matched run listings in human text', async () => {
    const project = await fixtureProject();
    const result = await runCli(['run', '--list', '--no-color'], project);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/listed.*test\.test\.md/i);
  });

  it('allows a grep-filtered empty run selection to exit successfully', async () => {
    const project = await fixtureProject();
    const result = await runCli(['run', '--allow-empty', '--grep', '^no-match$', '--json'], project);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({
      command: 'run',
      summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
      results: [],
      errors: [],
    });
  });

  it('reports a missing run plan through the built CLI with exit 4', async () => {
    const project = await fixtureProject();
    const result = await runCli(['run', '--json'], project);

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({
      command: 'run',
      reportPersistence: 'persisted',
      errors: [expect.objectContaining({ scope: 'case', code: 'MISSING_PLAN' })],
    });
  });

  it('reports a stale run plan through the built CLI with exit 4', async () => {
    const project = await fixtureProject();
    await writeStalePlan(project);
    const result = await runCli(['run', '--json'], project);

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({
      command: 'run',
      reportPersistence: 'persisted',
      errors: [expect.objectContaining({ scope: 'case', code: 'STALE_PLAN' })],
    });
  });

  it('rejects run stale regeneration with the documented configuration error', async () => {
    const project = await fixtureProject();
    const result = await runCli(['run', '--json', '--stale', 'regenerate'], project);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    const envelope = JSON.parse(result.stdout);
    expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
    expect(envelope).toMatchObject({
      command: 'run',
      errors: [expect.objectContaining({
        scope: 'run',
        code: 'CONFIG_INVALID',
        message: 'The --stale=regenerate option is unsupported; only --stale=fail is supported.',
      })],
    });
  });

  it('keeps an invalid run grep regex as a plain-text parse failure', async () => {
    const project = await fixtureProject();
    const result = await runCli(['run', '--json', '--grep', '['], project);

    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/grep.*valid regular expression/i);
    expect(result.stderr.trim().startsWith('{')).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it('has a #!/usr/bin/env node shebang as its first line', async () => {
    const firstLine = (await readFile(binPath, 'utf8')).split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it('is executable as published', async () => {
    if (process.platform !== 'win32') {
      await expect(access(binPath, constants.X_OK)).resolves.toBeUndefined();
    }
  });
});
