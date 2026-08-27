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
  finalizeReportEnvelope: vi.fn(),
  isEmergencyFinalizedEnvelope: vi.fn(),
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
vi.mock('#usecases/report-finalization.js', () => ({
  finalizeReportEnvelope: mocks.finalizeReportEnvelope,
  isEmergencyFinalizedEnvelope: mocks.isEmergencyFinalizedEnvelope,
}));

const rawEnvelopeForFinalizedBoundary = {} as ReportEnvelope;
// @ts-expect-error A real command output cannot expose an unfinalized envelope.
const rawGenerateCommandOutput: GenerateCommandOutput = { exitCode: 0, envelope: rawEnvelopeForFinalizedBoundary };
void rawGenerateCommandOutput;

const CONFIG: ResolvedConfig = {
  testDir: '/workspace/tests',
  runsDir: '/workspace/tests/.runs',
  projectRoot: '/workspace',
  testMatch: ['**/*.test.md'],
  testIgnore: [],
  targets: { web: { baseUrl: 'https://example.test', browser: 'chromium' } },
  defaultTarget: 'web',
  ai: { provider: 'auto', timeoutMs: 120_000 },
  viewer: { port: 4600 },
  ci: { heal: false, updateGroundingCache: false },
  grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
};

function reportOutput(
  exitCode: GenerateCommandOutput['exitCode'],
  errors: ReportError[] = [],
): GenerateCommandOutput {
  const output = {
    exitCode,
    envelope: {
      schemaVersion: '3.0' as const,
      command: 'generate',
      startedAt: '2026-08-08T00:00:00Z',
      durationMs: 1,
      summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
      errors,
      results: [],
    },
  } as unknown as GenerateCommandOutput;

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

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('#usecases/report-finalization.js')>(
    '#usecases/report-finalization.js',
  );
  mocks.finalizeReportEnvelope.mockImplementation(actual.finalizeReportEnvelope);
  mocks.isEmergencyFinalizedEnvelope.mockImplementation(actual.isEmergencyFinalizedEnvelope);
  mocks.createSystemClock.mockReturnValue({
    now: () => new Date('2026-08-08T00:00:00Z'),
    monotonicMs: () => 10,
  });
});

describe('runGenerateCommand', () => {
  it('returns identities relative to the config-resolved root rather than cwd', async () => {
    const { output } = arrangeSuccessfulCommand('codex', 'codex');
    const projectRoot = '/workspace/config-parent';
    const cwd = `${projectRoot}/nested-cwd`;
    const rawEnvelope = {
      ...output.envelope,
      schemaVersion: '3.0',
      results: [{ id: `${cwd}/tests/login.test.md`, file: `${cwd}/tests/login.test.md`, planFile: `${cwd}/tests/login.ambercast.plan.json`, status: 'generated', dryRun: false, ambiguities: [] }],
      summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 },
    } as unknown as GenerateCommandOutput['envelope'];
    mocks.loadConfig.mockResolvedValue({ ...CONFIG, projectRoot, testDir: `${projectRoot}/tests`, runsDir: `${projectRoot}/tests/.runs` });
    mocks.buildGenerateReport.mockReturnValue({ ...output, envelope: rawEnvelope });

    const returned = await runGenerateCommand(input({ cwd }));

    expect(returned.envelope.results).toMatchObject([{
      id: 'nested-cwd/tests/login.test.md',
      file: 'nested-cwd/tests/login.test.md',
      planFile: 'nested-cwd/tests/login.ambercast.plan.json',
    }]);
    expect(returned.envelope.results[0]).not.toMatchObject({ id: `${cwd}/tests/login.test.md` });
    expect(returned.envelope.results[0]).not.toMatchObject({ id: 'tests/login.test.md' });
  });

  it('finalizes the completed report against the resolved project root', async () => {
    const { output } = arrangeSuccessfulCommand('codex', 'codex');
    mocks.finalizeReportEnvelope.mockImplementation((raw) => raw);
    mocks.isEmergencyFinalizedEnvelope.mockReturnValue(false);

    await runGenerateCommand(input());

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(output.envelope, '/workspace');
  });

  it('finalizes an error report with cwd when configuration never resolves', async () => {
    const built = reportOutput(2);
    mocks.loadConfig.mockRejectedValue(new UnexpectedCrashError('config unavailable'));
    mocks.buildGenerateReport.mockReturnValue(built);
    mocks.finalizeReportEnvelope.mockImplementation((raw) => raw);
    mocks.isEmergencyFinalizedEnvelope.mockReturnValue(false);

    await runGenerateCommand(input({ cwd: '/workspace/fallback' }));

    expect(mocks.finalizeReportEnvelope).toHaveBeenCalledExactlyOnceWith(built.envelope, '/workspace/fallback');
  });

  it('uses cwd as the resolved project root for a successful no-config invocation', async () => {
    const { output } = arrangeSuccessfulCommand('codex', 'codex');
    const cwd = '/workspace/no-config-project';
    const config = { ...CONFIG, projectRoot: cwd, testDir: `${cwd}/tests`, runsDir: `${cwd}/tests/.runs` };
    const rawEnvelope = { ...output.envelope, schemaVersion: '3.0', results: [{ id: `${cwd}/tests/login.test.md`, file: `${cwd}/tests/login.test.md`, planFile: `${cwd}/tests/login.ambercast.plan.json`, status: 'generated', dryRun: false, ambiguities: [] }], summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0 } } as unknown as GenerateCommandOutput['envelope'];
    mocks.loadConfig.mockResolvedValue(config);
    mocks.buildGenerateReport.mockReturnValue({ ...output, envelope: rawEnvelope });

    const returned = await runGenerateCommand(input({ cwd }));

    expect(config.projectRoot).toBe(cwd);
    expect(mocks.loadConfig).toHaveBeenCalledWith(expect.objectContaining({ cwd }));
    expect(mocks.loadConfig.mock.calls[0]?.[0]).not.toHaveProperty('configPathOverride');
    expect(returned.envelope.results).toMatchObject([{
      id: 'tests/login.test.md',
      file: 'tests/login.test.md',
      planFile: 'tests/login.ambercast.plan.json',
    }]);
  });

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
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
    const reason = new Error('stop probing');
    let observedSignal: AbortSignal | undefined;
    const isAvailable = vi.fn(async (signal?: AbortSignal) => {
      observedSignal = signal;
      controller.abort(reason);
      return false;
    });
    mocks.loadConfig.mockResolvedValue(CONFIG);
    mocks.claudeFactory.mockReturnValue({ name: 'claude-code-cli', isAvailable });
    const output = reportOutput(3, [{
      scope: 'run', kind: 'environment', code: 'UNEXPECTED_CRASH', message: 'The generate command crashed unexpectedly.',
    }]);
    mocks.buildGenerateReport.mockReturnValue(output);

    try {
      await expect(runGenerateCommand(input({ signal: controller.signal }))).resolves.toEqual(output);
      expect(observedSignal).not.toBe(controller.signal);
      expect(observedSignal?.aborted).toBe(true);
      expect(observedSignal?.reason).toBe(reason);
      expect(mocks.codexFactory).not.toHaveBeenCalled();
      expect(mocks.buildGenerateReport).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.any(UnexpectedCrashError),
      }));
    } finally {
      timeoutSpy.mockRestore();
    }
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

  it.each(['completed', 'error'] as const)('forces exit 3 when %s finalization returns the emergency singleton', async (branch) => {
    const built = reportOutput(0);
    arrangeSuccessfulCommand('codex', 'codex');
    mocks.buildGenerateReport.mockReturnValue(built);
    if (branch === 'error') {
      mocks.loadConfig.mockRejectedValue(new UnexpectedCrashError('configuration failed'));
    }
    mocks.finalizeReportEnvelope.mockReturnValue(built.envelope);
    mocks.isEmergencyFinalizedEnvelope.mockReturnValue(true);

    await expect(runGenerateCommand(input())).resolves.toEqual({
      exitCode: 3,
      envelope: built.envelope,
    });
  });
});
