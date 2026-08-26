import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEnvelope } from '#report/schema.js';
import type { GenerateCommandInput } from '#runtime/generate-command.js';
import type { CheckCommandInput } from '#runtime/check-command.js';
import type { HealCommandInput } from '#runtime/heal-command.js';

const runGenerateCommand = vi.hoisted(() => vi.fn());
const runRunCommand = vi.hoisted(() => vi.fn());
const runCheckCommand = vi.hoisted(() => vi.fn());
const runHealCommand = vi.hoisted(() => vi.fn());
vi.mock('#runtime/generate-command.js', () => ({ runGenerateCommand }));
vi.mock('#runtime/run-command.js', () => ({ runRunCommand }));
vi.mock('#runtime/check-command.js', () => ({ runCheckCommand }));
vi.mock('#runtime/heal-command.js', () => ({ runHealCommand }));

import { main, REPORT_PERSISTENCE_FAILED_WARNING } from '../../src/cli/main.js';

class MemoryWritable extends Writable {
  chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  get text(): string {
    return this.chunks.join('');
  }
}

const ENVELOPE = {
  schemaVersion: '2.0' as const,
  command: 'generate' as const,
  startedAt: '2026-08-08T00:00:00Z',
  durationMs: 0,
  summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
  errors: [],
  results: [{ id: 'login', file: 'login.test.md', status: 'listed' as const, dryRun: false }],
};

const RUN_ENVELOPE = {
  schemaVersion: '2.0' as const,
  command: 'run' as const,
  startedAt: '2026-08-09T00:00:00Z',
  durationMs: 0,
  summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
  errors: [],
  results: [],
  reportPersistence: 'persisted' as const,
};

const CHECK_ENVELOPE = {
  schemaVersion: '2.0' as const,
  command: 'check' as const,
  startedAt: '2026-08-17T00:00:00Z',
  durationMs: 0,
  summary: { total: 2, passed: 1, failed: 1, errored: 0, skipped: 0 },
  errors: [],
  results: [
    {
      id: 'fresh.test.md',
      file: 'fresh.test.md',
      planFile: 'fresh.ambercast.plan.json',
      status: 'fresh' as const,
      reason: 'The plan matches the current prompt and target.',
    },
    {
      id: 'stale.test.md',
      file: 'stale.test.md',
      planFile: 'stale.ambercast.plan.json',
      status: 'stale' as const,
      reason: 'The plan is stale for the current prompt or target.',
    },
  ],
};

const HEAL_ENVELOPE = {
  schemaVersion: '2.0' as const,
  command: 'heal' as const,
  startedAt: '2026-08-25T00:00:00Z',
  durationMs: 0,
  summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
  errors: [],
  results: [],
};

let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;
let initialExitCode: typeof process.exitCode;

beforeEach(() => {
  initialExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = initialExitCode;
  cwdSpy?.mockRestore();
  cwdSpy = undefined;
  runGenerateCommand.mockReset();
  runRunCommand.mockReset();
  runCheckCommand.mockReset();
  runHealCommand.mockReset();
});

async function run(argv: readonly string[]) {
  const stdout = new MemoryWritable();
  const stderr = new MemoryWritable();

  await main(argv, stdout, stderr);

  return { stdout: stdout.text, stderr: stderr.text, exitCode: process.exitCode };
}

describe('main()', () => {
  it('renders skipped rows as non-healthy without fabricating execution or inspection evidence', async () => {
    runCheckCommand.mockResolvedValue({
      exitCode: 3,
      envelope: {
        schemaVersion: '2.0', command: 'check', startedAt: '2026-08-17T00:00:00Z', durationMs: 0,
        summary: { total: 1, passed: 0, failed: 0, errored: 0, skipped: 1 },
        errors: [{ scope: 'run', kind: 'environment', code: 'INTERRUPTED', message: 'The command was interrupted before all discovered cases reached a terminal state.' }],
        results: [{ id: 'pending.test.md', file: 'pending.test.md', status: 'skipped' }],
      },
    } as never);

    const result = await run(['check', '--no-color']);

    expect(result.stdout).toContain('skipped pending.test.md');
    expect(result.stdout).not.toContain('fresh');
    expect(result.stdout).not.toContain('duration');
    expect(result.stdout).not.toContain('inspection');
    expect(result.exitCode).toBe(3);
  });

  it('renders the fixed orphan-grounding reason without exposing its artifact path', async () => {
    const artifactPath = '/workspace/tests/private/deleted.ambercast.grounding.json';
    runCheckCommand.mockResolvedValue({
      exitCode: 4,
      envelope: {
        schemaVersion: '2.0', command: 'check', startedAt: '2026-08-17T00:00:00Z', durationMs: 0,
        summary: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0 }, errors: [],
        results: [{ id: 'deleted.test.md', file: 'deleted.test.md', planFile: 'deleted.ambercast.plan.json', groundingFile: artifactPath, status: 'orphaned-grounding', reason: 'No corresponding test file exists for this grounding artifact.' }],
      },
    } as never);

    const result = await run(['check', '--no-color']);

    expect(result.stdout).toContain('No corresponding test file exists for this grounding artifact.');
    expect(result.stdout).not.toContain(artifactPath);
  });

  it('prints usage and exits 0 when no command is supplied', async () => {
    const result = await run([]);

    expect(result.stdout).toMatch(/usage/i);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('short-circuits top-level version and help before command lookup', async () => {
    const version = await run(['--version']);
    expect(version.stdout).toMatch(/^ambercast v\d+\.\d+\.\d+/);
    expect(version.exitCode).toBe(0);

    const help = await run(['--help']);
    expect(help.stdout).toMatch(/generate/);
    expect(help.exitCode).toBe(0);
    expect(runGenerateCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown command', ['unknown']],
    ['unknown flag even with JSON requested', ['generate', '--json', '--unknown']],
    ['missing target value', ['generate', '--target']],
    ['missing AI provider value', ['generate', '--ai']],
    ['missing config value', ['generate', '--config']],
    ['unsupported provider', ['generate', '--ai', 'other']],
  ] as const)('writes plain usage to stderr and exits 2 for %s', async (_description, argv) => {
    const result = await run(argv);

    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/usage|unknown|missing/i);
    expect(result.stderr.trim().startsWith('{')).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(runGenerateCommand).not.toHaveBeenCalled();
  });

  it('passes parsed list flags and literal paths to runtime then renders its human report', async () => {
    runGenerateCommand.mockResolvedValue({ exitCode: 0, envelope: ENVELOPE });

    const result = await run(['generate', 'login.test.md', '--list', '--no-color', '--config', 'ambercast.config.json']);

    expect(runGenerateCommand).toHaveBeenCalledWith(expect.objectContaining({
      files: ['login.test.md'], list: true, dryRun: false, force: false, strict: false,
      configPathOverride: 'ambercast.config.json',
    }));
    expect(result.stdout).toContain('login.test.md');
    expect(result.stdout).not.toMatch(/\u001B\[/);
    expect(result.exitCode).toBe(0);
  });

  it.each([
    ['target', ['generate', '--target', 'web'], { target: 'web' }],
    ['Claude provider', ['generate', '--ai', 'claude'], { aiProviderOverride: 'claude' }],
    ['Codex provider', ['generate', '--ai', 'codex'], { aiProviderOverride: 'codex' }],
    ['force', ['generate', '--force'], { force: true }],
    ['allow-empty', ['generate', '--allow-empty'], { allowEmpty: true }],
  ] as const)('parses the documented generate %s flag', async (_description, argv, expectedInput) => {
    runGenerateCommand.mockResolvedValue({ exitCode: 0, envelope: ENVELOPE });

    await run(argv);

    expect(runGenerateCommand).toHaveBeenCalledWith(expect.objectContaining(expectedInput));
  });

  it('treats values after -- as literal paths, including option-shaped names', async () => {
    runGenerateCommand.mockResolvedValue({ exitCode: 0, envelope: ENVELOPE });

    await run(['generate', '--', '--not-an-option.test.md']);

    expect(runGenerateCommand).toHaveBeenCalledWith(expect.objectContaining({ files: ['--not-an-option.test.md'] }));
  });

  it('short-circuits command-local generate help before calling runtime', async () => {
    const result = await run(['generate', '--help']);

    expect(result.stdout).toMatch(/generate|usage/i);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(runGenerateCommand).not.toHaveBeenCalled();
  });

  it('passes the current working directory to runtime configuration selection', async () => {
    runGenerateCommand.mockResolvedValue({ exitCode: 0, envelope: ENVELOPE });
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace/project');

    await run(['generate']);

    expect(runGenerateCommand).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace/project' }));
  });

  it('forwards SIGINT through the runtime signal and removes both process listeners after completion', async () => {
    let receivedSignal: AbortSignal | undefined;
    const initialSigintListeners = process.listenerCount('SIGINT');
    const initialSigtermListeners = process.listenerCount('SIGTERM');
    runGenerateCommand.mockImplementation(async (commandInput: GenerateCommandInput) => {
      receivedSignal = commandInput.signal;
      process.emit('SIGINT');
      return { exitCode: 0, envelope: ENVELOPE };
    });

    await run(['generate']);

    expect(receivedSignal?.aborted).toBe(true);
    expect(process.listenerCount('SIGINT')).toBe(initialSigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(initialSigtermListeners);
  });

  it('writes exactly one valid JSON envelope for a parsed dry-run invocation', async () => {
    const envelope = {
      ...ENVELOPE,
      results: [{
        ...ENVELOPE.results[0],
        status: 'would-generate' as const,
        dryRun: true,
        planFile: 'login.ambercast.plan.json',
        ambiguities: [],
      }],
    };
    runGenerateCommand.mockResolvedValue({ exitCode: 1, envelope });

    const result = await run(['generate', '--dry-run', '--strict', '--json']);

    expect(runGenerateCommand).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, strict: true }));
    expect(ReportEnvelope.safeParse(JSON.parse(result.stdout)).success).toBe(true);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('keeps an unexpected runtime rejection inside the documented exit-code contract', async () => {
    runGenerateCommand.mockRejectedValue(new Error('unexpected test rejection'));

    const result = await run(['generate']);

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('The generate command crashed unexpectedly.\n');
    expect(result.exitCode).toBe(3);
  });

  it('passes every documented run argument to runtime and renders JSON output', async () => {
    runRunCommand.mockResolvedValue({ exitCode: 0, envelope: RUN_ENVELOPE });

    const result = await run([
      'run',
      'login.test.md',
      'checkout.test.md',
      '--grep',
      'login|checkout',
      '--target',
      'web',
      '--headed',
      '--json',
      '--cache-only',
      '--update-cache',
      '--stale',
      'regenerate',
      '--ai',
      'claude',
    ]);

    expect(runRunCommand).toHaveBeenCalledWith(expect.objectContaining({
      files: ['login.test.md', 'checkout.test.md'],
      grep: expect.any(RegExp),
      target: 'web',
      headed: true,
      cacheOnly: true,
      updateCache: true,
      stale: 'regenerate',
      aiProviderOverride: 'claude',
    }));
    const commandInput = runRunCommand.mock.calls[0]?.[0] as { grep?: RegExp };
    expect(commandInput.grep).toEqual(/login|checkout/);
    expect(JSON.parse(result.stdout)).toEqual(RUN_ENVELOPE);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('accepts Codex as a run provider override', async () => {
    runRunCommand.mockResolvedValue({ exitCode: 0, envelope: RUN_ENVELOPE });

    await run(['run', '--ai', 'codex']);

    expect(runRunCommand).toHaveBeenCalledWith(expect.objectContaining({ aiProviderOverride: 'codex' }));
  });

  it.each([
    ['JSON', ['run', '--json']],
    ['human-rendered', ['run', '--no-color']],
  ] as const)('writes the fixed persistence warning for a failed %s run', async (_mode, argv) => {
    runRunCommand.mockResolvedValue({
      exitCode: 3,
      envelope: { ...RUN_ENVELOPE, reportPersistence: 'failed' as const },
    });

    const result = await run(argv);

    expect(result.stderr).toBe(`${REPORT_PERSISTENCE_FAILED_WARNING}\n`);
    expect(result.stderr).not.toContain('/workspace');
    expect(result.stderr).not.toContain('disk full');
  });

  it.each(['persisted', 'not-attempted'] as const)('omits the persistence warning for a %s run', async (reportPersistence) => {
    runRunCommand.mockResolvedValue({
      exitCode: 0,
      envelope: { ...RUN_ENVELOPE, reportPersistence },
    });

    const result = await run(['run', '--json']);

    expect(result.stderr).not.toContain(REPORT_PERSISTENCE_FAILED_WARNING);
  });

  it('accepts fail as an explicit run stale policy', async () => {
    runRunCommand.mockResolvedValue({ exitCode: 0, envelope: RUN_ENVELOPE });

    await run(['run', '--stale', 'fail']);

    expect(runRunCommand).toHaveBeenCalledWith(expect.objectContaining({ stale: 'fail', updateCache: false }));
  });

  it('renders --update-cache in the actual usage text', async () => {
    const result = await run(['--help']);

    expect(result.stdout).toContain('--update-cache');
  });

  it.each(['generate', 'check'] as const)('rejects --update-cache for %s before runtime composition', async (command) => {
    const result = await run([command, '--update-cache']);

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Unknown ${command} option: --update-cache.`);
    expect(result.exitCode).toBe(2);
    if (command === 'generate') {
      expect(runGenerateCommand).not.toHaveBeenCalled();
    } else {
      expect(runCheckCommand).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['allow-empty', ['run', '--allow-empty'], { allowEmpty: true, list: false }],
    ['list', ['run', '--list'], { allowEmpty: false, list: true }],
    ['allow-empty and list', ['run', '--allow-empty', '--list'], { allowEmpty: true, list: true }],
  ] as const)('parses the run %s flag combination', async (_description, argv, expectedInput) => {
    runRunCommand.mockResolvedValue({ exitCode: 0, envelope: RUN_ENVELOPE });

    await run(argv);

    expect(runRunCommand).toHaveBeenCalledWith(expect.objectContaining(expectedInput));
  });

  it('disables ANSI styling for human run output with --no-color', async () => {
    runRunCommand.mockResolvedValue({
      exitCode: 1,
      envelope: { ...RUN_ENVELOPE, results: [{ file: 'login.test.md', status: 'failed' }] },
    });

    const result = await run(['run', '--no-color']);

    expect(runRunCommand).toHaveBeenCalledOnce();
    expect(result.stdout).toContain('failed login.test.md');
    expect(result.stdout).not.toMatch(/\u001B\[/);
  });

  it('treats values after -- as literal paths, including option-shaped names', async () => {
    runRunCommand.mockResolvedValue({ exitCode: 0, envelope: RUN_ENVELOPE });

    await run(['run', '--', '--not-an-option.test.md']);

    expect(runRunCommand).toHaveBeenCalledWith(expect.objectContaining({ files: ['--not-an-option.test.md'] }));
  });

  it.each([
    ['unknown run flag even with JSON requested', ['run', '--json', '--unknown']],
    ['missing grep value', ['run', '--grep']],
    ['missing target value', ['run', '--target']],
    ['missing stale value', ['run', '--stale']],
    ['missing AI provider value', ['run', '--ai']],
    ['unsupported provider', ['run', '--ai', 'other']],
  ] as const)('writes plain usage to stderr and exits 2 for %s', async (_description, argv) => {
    const result = await run(argv);

    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/usage|unknown|missing|must be/i);
    expect(result.stderr.trim().startsWith('{')).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(runRunCommand).not.toHaveBeenCalled();
  });

  it('rejects a malformed run grep pattern before command composition', async () => {
    const result = await run(['run', '--json', '--grep', '[']);

    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/grep.*valid regular expression/i);
    expect(result.stderr.trim().startsWith('{')).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(runRunCommand).not.toHaveBeenCalled();
  });

  it('rejects an unsupported run stale policy as a parse-usage error', async () => {
    const result = await run(['run', '--stale', 'other']);

    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/stale.*fail.*regenerate/i);
    expect(result.stderr.trim().startsWith('{')).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(runRunCommand).not.toHaveBeenCalled();
  });

  it('short-circuits command-local run help before calling runtime', async () => {
    const result = await run(['run', '--help']);

    expect(result.stdout).toMatch(/run \[files\.\.\.\].*replay deterministic plans/i);
    const runOptions = result.stdout.slice(result.stdout.indexOf('Run options:'), result.stdout.indexOf('Check options:'));
    expect(runOptions).toContain('--stale <fail>');
    expect(runOptions).toContain('--no-color');
    expect(runOptions).not.toContain('--stale <fail|regenerate>');
    expect(runOptions).not.toContain('--ai <claude|codex>');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(runRunCommand).not.toHaveBeenCalled();
  });

  it('documents --allow-empty and --list in run usage text', async () => {
    const result = await run(['run', '--help']);
    const runOptions = result.stdout.slice(result.stdout.indexOf('Run options:'));

    expect(runOptions).toContain('--allow-empty');
    expect(runOptions).toContain('--list');
  });

  it('passes check positionals and every supported flag to runtime', async () => {
    runCheckCommand.mockResolvedValue({ exitCode: 4, envelope: CHECK_ENVELOPE });

    await run([
      'check',
      'login.test.md',
      'checkout.test.md',
      '--target',
      'web',
      '--allow-empty',
      '--list',
      '--json',
      '--config',
      'ambercast.config.json',
      '--no-color',
    ]);

    expect(runCheckCommand).toHaveBeenCalledWith(expect.objectContaining({
      files: ['login.test.md', 'checkout.test.md'],
      target: 'web',
      allowEmpty: true,
      list: true,
      configPathOverride: 'ambercast.config.json',
    }));
  });

  it('treats option-shaped check paths after -- as literal positionals', async () => {
    runCheckCommand.mockResolvedValue({ exitCode: 0, envelope: CHECK_ENVELOPE });

    await run(['check', '--', '--literal.test.md']);

    expect(runCheckCommand).toHaveBeenCalledWith(expect.objectContaining({ files: ['--literal.test.md'] }));
  });

  it('rejects an unknown check flag before runtime composition', async () => {
    const result = await run(['check', '--unknown']);

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unknown check option: --unknown.');
    expect(result.exitCode).toBe(2);
    expect(runCheckCommand).not.toHaveBeenCalled();
  });

  it.each([
    '--strict',
    '--force',
    '--dry-run',
    '--ai',
    '--grep',
    '--headed',
    '--cache-only',
    '--stale',
    '--update-cache',
  ] as const)('rejects the generate/run-only %s flag before runtime composition', async (flag) => {
    const result = await run(['check', flag]);

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Unknown check option: ${flag}.`);
    expect(result.exitCode).toBe(2);
    expect(runCheckCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['target', ['check', '--target']],
    ['config', ['check', '--config']],
  ] as const)('rejects a check %s flag missing its value before runtime composition', async (_name, argv) => {
    const result = await run(argv);

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`Missing value for --${_name}.`);
    expect(result.exitCode).toBe(2);
    expect(runCheckCommand).not.toHaveBeenCalled();
  });

  it('short-circuits check help before runtime composition', async () => {
    const result = await run(['check', '--help']);

    expect(result.stdout).toMatch(/check \[files\.\.\.\].*check plan freshness/i);
    expect(result.stdout).toContain('Check options:');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(runCheckCommand).not.toHaveBeenCalled();
  });

  it('dispatches check to runtime and renders exactly one JSON check envelope', async () => {
    runCheckCommand.mockResolvedValue({ exitCode: 4, envelope: CHECK_ENVELOPE });

    const result = await run(['check', '--json']);

    expect(runCheckCommand).toHaveBeenCalledOnce();
    expect(ReportEnvelope.parse(JSON.parse(result.stdout))).toEqual(CHECK_ENVELOPE);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(4);
  });

  it('renders fresh green and non-fresh non-green check rows with their reasons', async () => {
    runCheckCommand.mockResolvedValue({ exitCode: 4, envelope: CHECK_ENVELOPE });

    const result = await run(['check']);

    expect(result.stdout).toContain('\u001B[32mfresh\u001B[0m fresh.test.md: The plan matches the current prompt and target.');
    expect(result.stdout).toContain('\u001B[31mstale\u001B[0m stale.test.md: The plan is stale for the current prompt or target.');
    expect(result.exitCode).toBe(4);
  });

  it('renders the uncommitted grounding waiver as a healthy green check row', async () => {
    runCheckCommand.mockResolvedValue({
      exitCode: 0,
      envelope: {
        ...CHECK_ENVELOPE,
        summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
        results: [{
          id: 'fresh.test.md', file: 'fresh.test.md', planFile: 'fresh.ambercast.plan.json',
          status: 'fresh-without-grounding',
          reason: "The plan is fresh; a grounding cache is not required by this project's repository policy.",
        }],
      },
    } as never);

    const result = await run(['check']);

    expect(result.stdout).toContain('\u001B[32mfresh-without-grounding\u001B[0m fresh.test.md');
    expect(result.exitCode).toBe(0);
  });

  it('passes a check runtime exit code through unchanged', async () => {
    runCheckCommand.mockResolvedValue({ exitCode: 3, envelope: { ...CHECK_ENVELOPE, errors: [{
      scope: 'case', kind: 'environment', code: 'FS_IO_ERROR', caseId: 'broken.test.md', message: 'read failed',
    }] } });

    const result = await run(['check', '--no-color']);

    expect(runCheckCommand).toHaveBeenCalledWith(expect.objectContaining({
      allowEmpty: false,
      list: false,
    } satisfies Partial<CheckCommandInput>));
    expect(result.stdout).not.toContain('\u001B[');
    expect(result.exitCode).toBe(3);
  });

  it.each([
    ['dry-run', ['heal', '--dry-run'], { dryRun: true }],
    ['target', ['heal', '--target', 'web'], { target: 'web' }],
    ['Claude provider', ['heal', '--ai', 'claude'], { aiProviderOverride: 'claude' }],
    ['Codex provider', ['heal', '--ai', 'codex'], { aiProviderOverride: 'codex' }],
    ['allow-empty', ['heal', '--allow-empty'], { allowEmpty: true }],
    ['list', ['heal', '--list'], { list: true }],
  ] as const)('parses the documented heal %s flag', async (_description, argv, expectedInput) => {
    runHealCommand.mockResolvedValue({ exitCode: 0, envelope: HEAL_ENVELOPE });

    await run(argv);

    expect(runHealCommand).toHaveBeenCalledWith(expect.objectContaining(expectedInput));
  });

  it('treats --yes and -y as interchangeable through the real heal parser', async () => {
    runHealCommand.mockResolvedValue({ exitCode: 0, envelope: HEAL_ENVELOPE });

    await run(['heal', '--yes']);
    const longForm = runHealCommand.mock.calls[0]?.[0] as HealCommandInput;
    runHealCommand.mockClear();

    await run(['heal', '-y']);
    const shortForm = runHealCommand.mock.calls[0]?.[0] as HealCommandInput;

    expect(longForm).toMatchObject({ yes: true });
    expect(shortForm).toMatchObject({ yes: true });
    expect({ ...shortForm, signal: undefined }).toEqual({ ...longForm, signal: undefined });
  });

  it('passes literal heal paths and option-shaped paths after -- to runtime', async () => {
    runHealCommand.mockResolvedValue({ exitCode: 0, envelope: HEAL_ENVELOPE });

    await run(['heal', 'login.test.md', 'checkout.test.md']);
    expect(runHealCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      files: ['login.test.md', 'checkout.test.md'],
    }));

    await run(['heal', '--', '--not-an-option.test.md']);
    expect(runHealCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      files: ['--not-an-option.test.md'],
    }));
  });

  it.each([
    ['unknown heal flag even with JSON requested', ['heal', '--json', '--unknown']],
    ['missing target value', ['heal', '--target']],
    ['missing AI provider value', ['heal', '--ai']],
    ['unsupported provider', ['heal', '--ai', 'other']],
  ] as const)('writes plain usage to stderr and exits 2 for %s', async (_description, argv) => {
    const result = await run(argv);

    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/usage|unknown|missing|must be/i);
    expect(result.stderr.trim().startsWith('{')).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(runHealCommand).not.toHaveBeenCalled();
  });

  it('short-circuits command-local heal help before calling runtime', async () => {
    const result = await run(['heal', '--help']);

    expect(result.stdout).toMatch(/heal \[files\.\.\.\].*repair deterministic plans/i);
    expect(result.stdout).toContain('--yes, -y');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(runHealCommand).not.toHaveBeenCalled();
  });

  it('renders exactly one JSON heal envelope and forwards target selection to runtime', async () => {
    runHealCommand.mockResolvedValue({ exitCode: 1, envelope: HEAL_ENVELOPE });

    const result = await run(['heal', '--json', '--target', 'web']);

    expect(runHealCommand).toHaveBeenCalledWith(expect.objectContaining({
      target: 'web',
    } satisfies Partial<HealCommandInput>));
    expect(ReportEnvelope.parse(JSON.parse(result.stdout))).toEqual(HEAL_ENVELOPE);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(1);
  });

  it('disables ANSI styling for human heal output with --no-color', async () => {
    runHealCommand.mockResolvedValue({
      exitCode: 1,
      envelope: {
        ...HEAL_ENVELOPE,
        summary: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0 },
        results: [{
          id: 'login.test.md', file: 'login.test.md', planFile: 'login.ambercast.plan.json',
          status: 'unresolved', steps: [], explanation: 'The repair did not resolve the case.',
          durationMs: 0, dryRun: false,
        }],
      },
    });

    const result = await run(['heal', '--no-color']);

    expect(runHealCommand).toHaveBeenCalledOnce();
    expect(result.stdout).toContain('unresolved login.test.md');
    expect(result.stdout).not.toMatch(/\u001B\[/);
  });
});
