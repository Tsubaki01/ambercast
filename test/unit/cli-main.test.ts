import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportEnvelope } from '#report/schema.js';
import type { GenerateCommandInput } from '#runtime/generate-command.js';

const runGenerateCommand = vi.hoisted(() => vi.fn());
vi.mock('#runtime/generate-command.js', () => ({ runGenerateCommand }));

import { main } from '../../src/cli/main.js';

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
});
