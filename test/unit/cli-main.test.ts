import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEnvelope } from '#report/schema.js';
import type { GenerateCommandInput } from '#runtime/generate-command.js';

const runGenerateCommand = vi.hoisted(() => vi.fn());
const runRunCommand = vi.hoisted(() => vi.fn());
vi.mock('#runtime/generate-command.js', () => ({ runGenerateCommand }));
vi.mock('#runtime/run-command.js', () => ({ runRunCommand }));

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
  schemaVersion: '1.0' as const,
  command: 'generate' as const,
  startedAt: '2026-08-08T00:00:00Z',
  durationMs: 0,
  summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
  errors: [],
  results: [{ id: 'login', file: 'login.test.md', status: 'listed' as const, dryRun: false }],
};

const RUN_ENVELOPE = {
  schemaVersion: '1.0' as const,
  command: 'run' as const,
  startedAt: '2026-08-09T00:00:00Z',
  durationMs: 0,
  summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
  errors: [],
  results: [],
  reportPersistence: 'persisted' as const,
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
});

async function run(argv: readonly string[]) {
  const stdout = new MemoryWritable();
  const stderr = new MemoryWritable();

  await main(argv, stdout, stderr);

  return { stdout: stdout.text, stderr: stderr.text, exitCode: process.exitCode };
}

describe('main()', () => {
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

    expect(runRunCommand).toHaveBeenCalledWith(expect.objectContaining({ stale: 'fail' }));
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
    const runOptions = result.stdout.slice(result.stdout.indexOf('Run options:'));
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
});
