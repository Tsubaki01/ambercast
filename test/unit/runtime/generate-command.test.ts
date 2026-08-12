import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '#core/config/schema.js';
import { AiExecutorUnavailableError } from '#core/errors/ai-executor-unavailable-error.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { ReportEnvelope, type ReportError } from '#report/schema.js';
import {
  runGenerateCommand,
  type GenerateCommandInput,
  type GenerateCommandOutput,
} from '#runtime/generate-command.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createAmbercast: vi.fn(),
  generate: vi.fn(),
  buildGenerateReport: vi.fn(),
  claudeFactory: vi.fn(),
  codexFactory: vi.fn(),
  createNoopEventSink: vi.fn(),
  createSystemClock: vi.fn(),
}));

vi.mock('#config/load.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('#runtime/create-ambercast.js', () => ({ createAmbercast: mocks.createAmbercast }));
vi.mock('#usecases/generate.js', () => ({ generate: mocks.generate }));
vi.mock('#usecases/generate-report.js', () => ({ buildGenerateReport: mocks.buildGenerateReport }));
vi.mock('#adapters/ai/registry.js', () => ({
  AI_EXECUTOR_FACTORIES: { claude: mocks.claudeFactory, codex: mocks.codexFactory },
}));
vi.mock('#adapters/system/noop-event-sink.js', () => ({ createNoopEventSink: mocks.createNoopEventSink }));
vi.mock('#adapters/system/system-clock.js', () => ({ createSystemClock: mocks.createSystemClock }));

const CONFIG: ResolvedConfig = {
  testDir: '/workspace/tests',
  runsDir: '/workspace/tests/.runs',
  testMatch: ['**/*.test.md'],
  testIgnore: [],
  targets: { web: { baseUrl: 'https://example.test', browser: 'chromium' } },
  defaultTarget: 'web',
  ai: { provider: 'auto', timeoutMs: 120_000 },
  viewer: { port: 4600 },
  ci: { heal: false, updateGroundingCache: false },
};

function reportOutput(
  exitCode: GenerateCommandOutput['exitCode'],
  errors: ReportError[] = [],
): GenerateCommandOutput {
  const output: GenerateCommandOutput = {
    exitCode,
    envelope: {
      schemaVersion: '1.0',
      command: 'generate',
      startedAt: '2026-08-08T00:00:00Z',
      durationMs: 1,
      summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
      errors,
      results: [],
    },
  };

  expect(ReportEnvelope.safeParse(output.envelope).success).toBe(true);
  return output;
}

function input(overrides: Partial<GenerateCommandInput> = {}): GenerateCommandInput {
  return {
    files: [], strict: false, force: false, dryRun: false, allowEmpty: false, list: false, cwd: '/workspace', ...overrides,
  };
}

function executor(provider: 'claude' | 'codex', available: boolean) {
  return {
    name: provider === 'claude' ? 'claude-code-cli' as const : 'codex-cli' as const,
    isAvailable: vi.fn(async () => available),
  };
}

function arrangeSuccessfulCommand(
  configuredProvider: ResolvedConfig['ai']['provider'],
  selectedProvider: 'claude' | 'codex',
) {
  const selected = executor(selectedProvider, true);
  const events = createRecordingEventSink();
  mocks.loadConfig.mockResolvedValue({ ...CONFIG, ai: { ...CONFIG.ai, provider: configuredProvider } });
  if (selectedProvider === 'claude') {
    mocks.claudeFactory.mockReturnValue(selected);
  } else {
    mocks.codexFactory.mockReturnValue(selected);
  }
  mocks.createNoopEventSink.mockReturnValue(events.sink);
  mocks.createAmbercast.mockReturnValue({
    aiExecutor: selected,
    clock: { now: () => new Date('2026-08-08T00:00:00Z'), monotonicMs: () => 10 },
  });
  mocks.generate.mockResolvedValue({ results: [], noTestsFound: false });
  const output = reportOutput(0);
  mocks.buildGenerateReport.mockReturnValue(output);
  return { selected, events, output };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

beforeEach(() => {
  mocks.createSystemClock.mockReturnValue({
    now: () => new Date('2026-08-08T00:00:00Z'),
    monotonicMs: () => 10,
  });
});

describe('runGenerateCommand', () => {
  it('loads config, lets an explicit provider override win, composes, and generates', async () => {
    const { events, selected, output } = arrangeSuccessfulCommand('auto', 'codex');

    await expect(runGenerateCommand(input({ aiProviderOverride: 'codex' }))).resolves.toEqual(output);
    expect(mocks.loadConfig).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace' }));
    expect(mocks.createAmbercast).toHaveBeenCalledWith(expect.objectContaining({ aiProvider: 'codex', events: events.sink }));
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ events: events.sink }), expect.objectContaining({ files: [] }));
    expect(selected.isAvailable).not.toHaveBeenCalled();
    expect(mocks.claudeFactory).not.toHaveBeenCalled();
  });

  it('passes captured configuration environment values into config loading', async () => {
    arrangeSuccessfulCommand('codex', 'codex');
    vi.stubEnv('AMBERCAST_CONFIG', 'from-environment.json');
    vi.stubEnv('AMBERCAST_AI_PROVIDER', 'claude');

    await runGenerateCommand(input());

    expect(mocks.loadConfig).toHaveBeenCalledWith(expect.objectContaining({
      configEnv: {
        configPathOverride: 'from-environment.json',
        aiProviderRaw: 'claude',
      },
    }));
  });

  it('anchors a relative literal prompt path to cwd before generation', async () => {
    arrangeSuccessfulCommand('codex', 'codex');

    await runGenerateCommand(input({ cwd: '/workspace/tests', files: ['login.test.md'] }));

    expect(mocks.generate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      files: ['/workspace/tests/login.test.md'],
    }));
  });

  it.each(['claude', 'codex'] as const)('passes configured %s through without auto probing', async (provider) => {
    const { selected } = arrangeSuccessfulCommand(provider, provider);

    await runGenerateCommand(input());

    expect(mocks.createAmbercast).toHaveBeenCalledWith(expect.objectContaining({ aiProvider: provider }));
    expect(selected.isAvailable).not.toHaveBeenCalled();
    expect(provider === 'claude' ? mocks.codexFactory : mocks.claudeFactory).not.toHaveBeenCalled();
  });

  it('probes Claude first and never constructs Codex when Claude is available', async () => {
    const calls: string[] = [];
    const claude = executor('claude', true);
    claude.isAvailable.mockImplementation(async () => {
      calls.push('claude available');
      return true;
    });
    arrangeSuccessfulCommand('auto', 'claude');
    mocks.claudeFactory.mockImplementation(() => {
      calls.push('claude factory');
      return claude;
    });
    mocks.createAmbercast.mockReturnValue({ aiExecutor: claude, clock: { now: () => new Date(), monotonicMs: () => 0 } });

    await runGenerateCommand(input());

    expect(calls).toEqual(['claude factory', 'claude available']);
    expect(mocks.claudeFactory).toHaveBeenCalledExactlyOnceWith({ run: expect.any(Function) });
    expect(mocks.codexFactory).not.toHaveBeenCalled();
  });

  it('probes Codex only after Claude reports unavailable', async () => {
    const calls: string[] = [];
    const claude = executor('claude', false);
    const codex = executor('codex', true);
    claude.isAvailable.mockImplementation(async () => {
      calls.push('claude available');
      return false;
    });
    codex.isAvailable.mockImplementation(async () => {
      calls.push('codex available');
      return true;
    });
    arrangeSuccessfulCommand('auto', 'codex');
    mocks.claudeFactory.mockImplementation(() => {
      calls.push('claude factory');
      return claude;
    });
    mocks.codexFactory.mockImplementation(() => {
      calls.push('codex factory');
      return codex;
    });
    mocks.createAmbercast.mockReturnValue({ aiExecutor: codex, clock: { now: () => new Date(), monotonicMs: () => 0 } });

    await runGenerateCommand(input());

    expect(calls).toEqual(['claude factory', 'claude available', 'codex factory', 'codex available']);
  });

  it('returns an exit-3 run-scoped unavailable-provider report when auto probing finds no provider', async () => {
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.claudeFactory.mockReturnValue(executor('claude', false));
    mocks.codexFactory.mockReturnValue(executor('codex', false));
    const output = reportOutput(3, [{
      scope: 'run', kind: 'environment', code: 'AI_EXECUTOR_UNAVAILABLE', message: 'No AI provider is available.',
    }]);
    mocks.buildGenerateReport.mockReturnValue(output);

    await expect(runGenerateCommand(input())).resolves.toEqual(output);
    expect(mocks.buildGenerateReport).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.any(AiExecutorUnavailableError),
    }));
    expect(output.envelope.errors).toEqual([expect.objectContaining({ scope: 'run', code: 'AI_EXECUTOR_UNAVAILABLE' })]);
  });

  it('passes cancellation into auto probing and classifies an unexpected probe rejection', async () => {
    const controller = new AbortController();
    const reason = new Error('stop probing');
    const isAvailable = vi.fn(async (signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(reason);
      return false;
    });
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.claudeFactory.mockReturnValue({ name: 'claude-code-cli', isAvailable });
    const output = reportOutput(3, [{
      scope: 'run', kind: 'environment', code: 'UNEXPECTED_CRASH', message: 'The generate command crashed unexpectedly.',
    }]);
    mocks.buildGenerateReport.mockReturnValue(output);

    await expect(runGenerateCommand(input({ signal: controller.signal }))).resolves.toEqual(output);
    expect(mocks.codexFactory).not.toHaveBeenCalled();
    expect(mocks.buildGenerateReport).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.any(UnexpectedCrashError),
    }));
  });

  it('measures a successful command from before configuration loading through report construction', async () => {
    const { output } = arrangeSuccessfulCommand('codex', 'codex');
    let monotonicCall = 0;
    mocks.createSystemClock.mockReturnValue({
      now: () => new Date('2026-08-08T00:00:00Z'),
      monotonicMs: () => {
        monotonicCall += 1;
        return monotonicCall === 1 ? 10 : 260;
      },
    });

    await expect(runGenerateCommand(input())).resolves.toEqual(output);

    expect(mocks.buildGenerateReport).toHaveBeenCalledWith(expect.objectContaining({
      startedAt: '2026-08-08T00:00:00Z',
      durationMs: 250,
    }));
  });

  it.each([0, 1, 2, 3, 4, 5] as const)('forwards report construction output for exit %i', async (exitCode) => {
    arrangeSuccessfulCommand('codex', 'codex');
    const output = reportOutput(exitCode);
    mocks.buildGenerateReport.mockReturnValue(output);

    await expect(runGenerateCommand(input())).resolves.toEqual(output);
  });

  it('passes a classified AI response failure into run-scoped report construction', async () => {
    const error = new AiResponseInvalidError('invalid AI response');
    mocks.loadConfig.mockRejectedValue(error);
    const output = reportOutput(3, [{
      scope: 'run', kind: 'environment', code: 'AI_RESPONSE_INVALID', message: 'invalid AI response',
    }]);
    mocks.buildGenerateReport.mockReturnValue(output);

    await expect(runGenerateCommand(input())).resolves.toEqual(output);
    expect(mocks.buildGenerateReport).toHaveBeenCalledWith(expect.objectContaining({ error }));
  });
});
